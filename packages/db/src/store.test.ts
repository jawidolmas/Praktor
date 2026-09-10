import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { newId } from "@exec/core";
import { openDb, type Db } from "./client.js";
import { runMigrations } from "./migrate.js";
import { decisions, objectives, runs, tasks } from "./schema.js";
import {
  acceptedRun,
  activeObjectives,
  addRuledOut,
  answerDecision,
  appendEvent,
  getSetting,
  markDecisionNotified,
  markObjectiveMerged,
  nextDecisionKey,
  readEvents,
  readyTasks,
  schedulableObjectives,
  setObjectiveStatus,
  setSetting,
  setTaskStatus,
  unnotifiedDecisions,
} from "./store.js";

const BUDGET = { maxTurns: 40, maxTokens: 400_000, maxWallClockMs: 1_800_000 };
const ACCEPTANCE = { checks: [{ label: "tests", command: "npm test", expectExitCode: 0, timeoutMs: 60_000 }] };

let db: Db;
let objectiveId: string;

function addTask(key: string, dependsOn: string[] = []): string {
  const id = newId();
  db.insert(tasks)
    .values({
      id, objectiveId, key, title: key, intent: `do ${key}`,
      taskClass: "implement", acceptance: ACCEPTANCE, dependsOn,
      status: "pending", attempts: 0, maxAttempts: 3, budget: BUDGET,
      ruledOut: [], createdAt: Date.now(), updatedAt: Date.now(),
    })
    .run();
  return id;
}

beforeEach(() => {
  db = openDb({ path: ":memory:" }).db;
  runMigrations(db);
  objectiveId = newId();
  db.insert(objectives)
    .values({
      id: objectiveId, title: "test objective", brief: "", repoPath: "/tmp/repo",
      baseRef: "HEAD", status: "active", budget: BUDGET,
      createdAt: Date.now(), updatedAt: Date.now(),
    })
    .run();
});

describe("readyTasks", () => {
  it("returns only tasks whose dependencies are all done", () => {
    const a = addTask("T-001");
    const b = addTask("T-002", [a]);
    addTask("T-003", [a, b]);

    expect(readyTasks(db, objectiveId).map((t) => t.key)).toEqual(["T-001"]);

    setTaskStatus(db, a, "done");
    expect(readyTasks(db, objectiveId).map((t) => t.key)).toEqual(["T-002"]);

    setTaskStatus(db, b, "done");
    expect(readyTasks(db, objectiveId).map((t) => t.key)).toEqual(["T-003"]);
  });

  it("excludes tasks that are running, blocked or already done", () => {
    const a = addTask("T-001");
    setTaskStatus(db, a, "running");
    expect(readyTasks(db, objectiveId)).toHaveLength(0);

    setTaskStatus(db, a, "blocked");
    expect(readyTasks(db, objectiveId)).toHaveLength(0);
  });
});

describe("answerDecision", () => {
  function raise(blockedTaskIds: string[]): string {
    const key = nextDecisionKey(db);
    db.insert(decisions)
      .values({
        id: newId(), key, objectiveId, level: "L2", title: "pick a store",
        context: "two viable options", risk: "medium", recommendation: "B",
        options: [
          { id: "A", label: "hard delete", pros: [], cons: [] },
          { id: "B", label: "soft delete", pros: [], cons: [] },
        ],
        blockedTaskIds, status: "open", createdAt: Date.now(),
      })
      .run();
    return key;
  }

  it("unblocks exactly the tasks that were waiting on it", () => {
    const blocked = addTask("T-001");
    const unrelated = addTask("T-002");
    setTaskStatus(db, blocked, "blocked");
    setTaskStatus(db, unrelated, "running");

    const key = raise([blocked]);
    expect(answerDecision(db, { key, answer: "B", answeredBy: "ceo" })).toBe(true);

    const rows = db.select().from(tasks).all();
    expect(rows.find((t) => t.id === blocked)?.status).toBe("pending");
    // The rest of the system keeps running: only the dependent branch was parked.
    expect(rows.find((t) => t.id === unrelated)?.status).toBe("running");
  });

  it("records the decision with its decision-maker and refuses a second answer", () => {
    const key = raise([]);
    expect(answerDecision(db, { key, answer: "A", answeredBy: "ceo" })).toBe(true);
    expect(answerDecision(db, { key, answer: "B", answeredBy: "someone" })).toBe(false);

    const row = db.select().from(decisions).all()[0]!;
    expect(row.status).toBe("answered");
    expect(row.answer).toBe("A");
    expect(row.answeredBy).toBe("ceo");
    expect(row.answeredAt).toBeTypeOf("number");
  });

  it("issues sequential, quotable keys", () => {
    expect(raise([])).toBe("DEC-001");
    expect(raise([])).toBe("DEC-002");
  });
});

describe("unnotifiedDecisions / markDecisionNotified", () => {
  function raise(): string {
    const key = nextDecisionKey(db);
    db.insert(decisions)
      .values({
        id: newId(), key, objectiveId, level: "L2", title: "pick a store",
        context: "two viable options", risk: "medium", recommendation: "B",
        options: [
          { id: "A", label: "hard delete", pros: [], cons: [] },
          { id: "B", label: "soft delete", pros: [], cons: [] },
        ],
        blockedTaskIds: [], status: "open", createdAt: Date.now(),
      })
      .run();
    return key;
  }

  it("lists open decisions that haven't been pushed yet, oldest first", () => {
    const first = raise();
    const second = raise();
    expect(unnotifiedDecisions(db).map((d) => d.key)).toEqual([first, second]);
  });

  it("drops a decision from the list once it's marked notified", () => {
    const key = raise();
    const row = db.select().from(decisions).where(eq(decisions.key, key)).get()!;
    markDecisionNotified(db, row.id, 42);

    expect(unnotifiedDecisions(db)).toHaveLength(0);
    const updated = db.select().from(decisions).where(eq(decisions.key, key)).get();
    expect(updated?.notifiedAt).toBeTypeOf("number");
    expect(updated?.notifiedMessageId).toBe(42);
  });

  it("excludes decisions that are already answered", () => {
    const key = raise();
    answerDecision(db, { key, answer: "A", answeredBy: "ceo" });
    expect(unnotifiedDecisions(db)).toHaveLength(0);
  });
});

describe("settings", () => {
  it("returns undefined for a key that was never set", () => {
    expect(getSetting(db, "telegram_update_offset")).toBeUndefined();
  });

  it("round-trips a value and overwrites it on a second set", () => {
    setSetting(db, "telegram_update_offset", "12");
    expect(getSetting(db, "telegram_update_offset")).toBe("12");

    setSetting(db, "telegram_update_offset", "13");
    expect(getSetting(db, "telegram_update_offset")).toBe("13");
  });
});

describe("event log", () => {
  it("appends and reads back in order", () => {
    appendEvent(db, { objectiveId, payload: { type: "note", message: "first" } });
    appendEvent(db, { objectiveId, payload: { type: "note", message: "second" } });

    const rows = readEvents(db, { objectiveId });
    expect(rows.map((r) => r.type)).toEqual(["note", "note"]);
    expect(rows.map((r) => (r.payload as { message: string }).message)).toEqual([
      "first",
      "second",
    ]);
  });

  it("records a status change as an event automatically", () => {
    const a = addTask("T-001");
    setTaskStatus(db, a, "running", "scheduled");

    const changes = readEvents(db, { objectiveId }).filter(
      (e) => e.type === "task.status_changed",
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]!.payload).toMatchObject({ from: "pending", to: "running", reason: "scheduled" });
  });
});

describe("activeObjectives", () => {
  it("returns only active objectives, oldest first", () => {
    const done = newId();
    db.insert(objectives)
      .values({
        id: done, title: "done objective", brief: "", repoPath: "/tmp/repo",
        baseRef: "HEAD", status: "done", budget: BUDGET,
        createdAt: Date.now() - 1000, updatedAt: Date.now(),
      })
      .run();
    const olderActive = newId();
    db.insert(objectives)
      .values({
        id: olderActive, title: "older active", brief: "", repoPath: "/tmp/repo",
        baseRef: "HEAD", status: "active", budget: BUDGET,
        createdAt: Date.now() - 2000, updatedAt: Date.now(),
      })
      .run();

    expect(activeObjectives(db).map((o) => o.id)).toEqual([olderActive, objectiveId]);
  });
});

describe("schedulableObjectives", () => {
  it("includes blocked and parked objectives, but not draft, done, failed or cancelled", () => {
    setObjectiveStatus(db, objectiveId, "blocked");

    const parked = newId();
    db.insert(objectives)
      .values({
        id: parked, title: "parked objective", brief: "", repoPath: "/tmp/repo",
        baseRef: "HEAD", status: "parked", budget: BUDGET,
        createdAt: Date.now(), updatedAt: Date.now(),
      })
      .run();
    for (const status of ["draft", "done", "failed", "cancelled"]) {
      db.insert(objectives)
        .values({
          id: newId(), title: status, brief: "", repoPath: "/tmp/repo",
          baseRef: "HEAD", status, budget: BUDGET,
          createdAt: Date.now(), updatedAt: Date.now(),
        })
        .run();
    }

    expect(schedulableObjectives(db).map((o) => o.id).sort()).toEqual([objectiveId, parked].sort());
  });
});

describe("setObjectiveStatus", () => {
  it("updates the row and records the transition as an event", () => {
    setObjectiveStatus(db, objectiveId, "parked", "rate limited");

    const row = db.select().from(objectives).where(eq(objectives.id, objectiveId)).get();
    expect(row?.status).toBe("parked");

    const changes = readEvents(db, { objectiveId }).filter(
      (e) => e.type === "objective.status_changed",
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]!.payload).toMatchObject({ from: "active", to: "parked", reason: "rate limited" });
  });

  it("is a no-op when the status is unchanged", () => {
    setObjectiveStatus(db, objectiveId, "active");
    const changes = readEvents(db, { objectiveId }).filter(
      (e) => e.type === "objective.status_changed",
    );
    expect(changes).toHaveLength(0);
  });
});

describe("ruled-out tracking", () => {
  it("accumulates without duplicates so a respawn cannot repeat an approach", () => {
    const a = addTask("T-001");
    addRuledOut(db, a, ["bump precedence table"]);
    addRuledOut(db, a, ["bump precedence table", "rewrite recursive call"]);

    const row = db.select().from(tasks).all().find((t) => t.id === a)!;
    expect(row.ruledOut).toEqual(["bump precedence table", "rewrite recursive call"]);
  });
});

function addRun(taskId: string, attempt: number): void {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  db.insert(runs)
    .values({
      id: newId(), taskId, objectiveId, attempt, sessionId: newId(),
      model: "claude-sonnet-5", effort: "medium", worktreePath: "/tmp/wt",
      status: "finished", exitReason: "completed", turns: 1, usage,
      costUsdEstimate: 0, startedAt: Date.now(),
    })
    .run();
}

describe("acceptedRun", () => {
  it("returns the highest-attempt run for a done objective's task", () => {
    const taskId = addTask("T-001");
    addRun(taskId, 1);
    addRun(taskId, 2);
    setObjectiveStatus(db, objectiveId, "done");

    const result = acceptedRun(db, objectiveId);
    expect(result).toEqual({ taskId, attempt: 2, repoPath: "/tmp/repo", baseRef: "HEAD" });
  });

  it("returns undefined when the objective isn't done yet", () => {
    const taskId = addTask("T-001");
    addRun(taskId, 1);
    expect(acceptedRun(db, objectiveId)).toBeUndefined();
  });

  it("returns undefined for an unknown objective", () => {
    expect(acceptedRun(db, "no-such-id")).toBeUndefined();
  });
});

describe("markObjectiveMerged", () => {
  it("records a merge timestamp on the objective", () => {
    expect(db.select().from(objectives).where(eq(objectives.id, objectiveId)).get()?.mergedAt).toBeNull();
    markObjectiveMerged(db, objectiveId);
    const row = db.select().from(objectives).where(eq(objectives.id, objectiveId)).get();
    expect(row?.mergedAt).toBeTypeOf("number");
  });
});
