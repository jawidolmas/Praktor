import { beforeEach, describe, expect, it } from "vitest";
import { newId } from "@exec/core";
import { openDb, type Db } from "./client.js";
import { runMigrations } from "./migrate.js";
import { decisions, objectives, tasks } from "./schema.js";
import {
  addRuledOut,
  answerDecision,
  appendEvent,
  nextDecisionKey,
  readEvents,
  readyTasks,
  setTaskStatus,
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

describe("ruled-out tracking", () => {
  it("accumulates without duplicates so a respawn cannot repeat an approach", () => {
    const a = addTask("T-001");
    addRuledOut(db, a, ["bump precedence table"]);
    addRuledOut(db, a, ["bump precedence table", "rewrite recursive call"]);

    const row = db.select().from(tasks).all().find((t) => t.id === a)!;
    expect(row.ruledOut).toEqual(["bump precedence table", "rewrite recursive call"]);
  });
});
