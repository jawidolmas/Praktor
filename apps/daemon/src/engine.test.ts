import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { newId } from "@exec/core";
import {
  decisions,
  objectives,
  openDb,
  runMigrations,
  tasks,
  type Db,
  type ObjectiveRow,
  type TaskRow,
} from "@exec/db";
import {
  applyAnsweredFailureDecisions,
  clampParkDelay,
  handlePermanentFailure,
  planRecoverySeed,
  shouldEscalateImmediately,
} from "./engine.js";

const BUDGET = { maxTurns: 40, maxTokens: 400_000, maxWallClockMs: 1_800_000 };
const ACCEPTANCE = { checks: [{ label: "tests", command: "npm test", expectExitCode: 0, timeoutMs: 60_000 }] };

let db: Db;

function addObjective(onFailure: "escalate" | "abandon" | "skip"): ObjectiveRow {
  const id = newId();
  db.insert(objectives)
    .values({
      id, title: "test objective", brief: "", repoPath: "/tmp/repo", baseRef: "HEAD",
      status: "active", budget: BUDGET, onFailure, createdAt: Date.now(), updatedAt: Date.now(),
    })
    .run();
  return db.select().from(objectives).where(eq(objectives.id, id)).get()!;
}

function addTask(objectiveId: string, key: string, dependsOn: string[] = []): TaskRow {
  const id = newId();
  db.insert(tasks)
    .values({
      id, objectiveId, key, title: key, intent: `do ${key}`, taskClass: "implement",
      acceptance: ACCEPTANCE, dependsOn, status: "pending", attempts: 3, maxAttempts: 3,
      budget: BUDGET, model: "claude-sonnet-5", effort: "medium", ruledOut: [],
      createdAt: Date.now(), updatedAt: Date.now(),
    })
    .run();
  return db.select().from(tasks).where(eq(tasks.id, id)).get()!;
}

beforeEach(() => {
  db = openDb({ path: ":memory:" }).db;
  runMigrations(db);
});

describe("clampParkDelay", () => {
  it("falls back to a default when no hint is given", () => {
    expect(clampParkDelay(undefined)).toBe(60_000);
  });

  it("falls back to the default for a non-finite hint", () => {
    expect(clampParkDelay(Number.NaN)).toBe(60_000);
    expect(clampParkDelay(Number.POSITIVE_INFINITY)).toBe(60_000);
  });

  it("floors an unreasonably short hint so the daemon never hammers the API", () => {
    expect(clampParkDelay(500)).toBe(30_000);
    expect(clampParkDelay(0)).toBe(30_000);
  });

  it("caps an unreasonably long hint so the daemon still checks back periodically", () => {
    expect(clampParkDelay(6 * 60 * 60_000)).toBe(30 * 60_000);
  });

  it("passes through a hint already inside the sane window", () => {
    expect(clampParkDelay(5 * 60_000)).toBe(5 * 60_000);
  });
});

const MECHANICAL = { note: "mechanical checkpoint note", ruledOut: ["mechanical ruled-out approach"] };

describe("planRecoverySeed", () => {
  it("carries nothing forward for 'retry' — a flaky failure is not a ruled-out approach", () => {
    const seed = planRecoverySeed("retry", MECHANICAL);
    expect(seed).toEqual({ ruledOutAdditions: [], checkpointNote: undefined });
  });

  it("seeds the diagnoser's own hint and ruled-out list for 'retry_with_hint'", () => {
    const seed = planRecoverySeed("retry_with_hint", MECHANICAL, {
      hint: "Try clamping the index instead of checking bounds first",
      ruledOut: ["checking bounds before indexing"],
    });
    expect(seed).toEqual({
      ruledOutAdditions: ["checking bounds before indexing"],
      checkpointNote: "Try clamping the index instead of checking bounds first",
    });
  });

  it("falls back to the mechanical checkpoint note for 'retry_with_hint' with no hint given", () => {
    const seed = planRecoverySeed("retry_with_hint", MECHANICAL, { ruledOut: [] });
    expect(seed.checkpointNote).toBe(MECHANICAL.note);
  });

  it("uses the full mechanical checkpoint for 'respawn'", () => {
    const seed = planRecoverySeed("respawn", MECHANICAL);
    expect(seed).toEqual({ ruledOutAdditions: MECHANICAL.ruledOut, checkpointNote: MECHANICAL.note });
  });

  it("also falls back to the mechanical checkpoint when no diagnosis was made (classifier failed or was skipped)", () => {
    const seed = planRecoverySeed(undefined, MECHANICAL);
    expect(seed).toEqual({ ruledOutAdditions: MECHANICAL.ruledOut, checkpointNote: MECHANICAL.note });
  });
});

describe("shouldEscalateImmediately", () => {
  it("is true for 'escalate' and 'abandon'", () => {
    expect(shouldEscalateImmediately("escalate")).toBe(true);
    expect(shouldEscalateImmediately("abandon")).toBe(true);
  });

  it("is false for every action that should continue the attempt loop, and when there's no diagnosis", () => {
    expect(shouldEscalateImmediately("retry")).toBe(false);
    expect(shouldEscalateImmediately("retry_with_hint")).toBe(false);
    expect(shouldEscalateImmediately("respawn")).toBe(false);
    expect(shouldEscalateImmediately(undefined)).toBe(false);
  });
});

describe("handlePermanentFailure", () => {
  it("escalate (default): blocks the task and objective on an L3 decision instead of failing outright", () => {
    const objective = addObjective("escalate");
    const task = addTask(objective.id, "T-001");

    handlePermanentFailure(db, task, objective);

    expect(db.select().from(tasks).where(eq(tasks.id, task.id)).get()?.status).toBe("blocked");
    expect(db.select().from(objectives).where(eq(objectives.id, objective.id)).get()?.status).toBe(
      "blocked",
    );
    const raised = db.select().from(decisions).where(eq(decisions.taskId, task.id)).all();
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ level: "L3", status: "open", recommendation: "B" });
  });

  it("abandon: fails the task, abandons the rest of the objective (dependents and unrelated siblings alike), and fails the objective immediately", () => {
    const objective = addObjective("abandon");
    const task = addTask(objective.id, "T-001");
    const dependent = addTask(objective.id, "T-002", [task.id]);
    const unrelated = addTask(objective.id, "T-003"); // no dependency relationship to T-001 at all

    handlePermanentFailure(db, task, objective);

    expect(db.select().from(tasks).where(eq(tasks.id, task.id)).get()?.status).toBe("failed");
    expect(db.select().from(tasks).where(eq(tasks.id, dependent.id)).get()?.status).toBe("abandoned");
    // Regression: "abandon" used to only cascade from the failed task to its
    // own dependents, leaving an unrelated sibling task sitting in "pending"
    // forever — never run, never abandoned, just orphaned once the objective
    // itself went terminal and stopped being scheduled at all.
    expect(db.select().from(tasks).where(eq(tasks.id, unrelated.id)).get()?.status).toBe("abandoned");
    expect(db.select().from(objectives).where(eq(objectives.id, objective.id)).get()?.status).toBe(
      "failed",
    );
  });

  it("skip: fails the task and cascades dependents, but leaves the objective for reconcileObjective to judge", () => {
    const objective = addObjective("skip");
    const task = addTask(objective.id, "T-001");
    const dependent = addTask(objective.id, "T-002", [task.id]);

    handlePermanentFailure(db, task, objective);

    expect(db.select().from(tasks).where(eq(tasks.id, task.id)).get()?.status).toBe("failed");
    expect(db.select().from(tasks).where(eq(tasks.id, dependent.id)).get()?.status).toBe("abandoned");
    // Still whatever it was — "skip" defers to reconcileObjective, which
    // lands it on "done" once nothing is left running.
    expect(db.select().from(objectives).where(eq(objectives.id, objective.id)).get()?.status).toBe(
      "active",
    );
  });
});

describe("applyAnsweredFailureDecisions", () => {
  function raiseAndAnswer(objective: ObjectiveRow, task: TaskRow, answer: string): void {
    handlePermanentFailure(db, task, objective); // objective is "escalate" in these tests
    // Filtered to "open", not just taskId: a task can accumulate more than
    // one L3 decision over multiple failure cycles, and this must always
    // target the one just raised, not whichever row an unordered query
    // happens to return first.
    const raised = db
      .select()
      .from(decisions)
      .where(and(eq(decisions.taskId, task.id), eq(decisions.status, "open")))
      .get()!;
    db.update(decisions)
      .set({ status: "answered", answer, answeredBy: "ceo", answeredAt: Date.now() })
      .where(eq(decisions.id, raised.id))
      .run();
  }

  it('"A" (abandon) fails the task, abandons the rest of the objective (dependents and unrelated siblings alike), and fails the objective', () => {
    const objective = addObjective("escalate");
    const task = addTask(objective.id, "T-001");
    const dependent = addTask(objective.id, "T-002", [task.id]);
    const unrelated = addTask(objective.id, "T-003");
    raiseAndAnswer(objective, task, "A");

    applyAnsweredFailureDecisions(db);

    expect(db.select().from(tasks).where(eq(tasks.id, task.id)).get()?.status).toBe("failed");
    expect(db.select().from(tasks).where(eq(tasks.id, dependent.id)).get()?.status).toBe("abandoned");
    // Regression: an unrelated sibling task used to be left in "pending"
    // forever — the objective goes terminal and stops being scheduled at
    // all, so nothing would ever have picked it back up.
    expect(db.select().from(tasks).where(eq(tasks.id, unrelated.id)).get()?.status).toBe("abandoned");
    expect(db.select().from(objectives).where(eq(objectives.id, objective.id)).get()?.status).toBe(
      "failed",
    );
  });

  it('"B" (grant more attempts) reopens the task with a bigger budget and reactivates the objective', () => {
    const objective = addObjective("escalate");
    const task = addTask(objective.id, "T-001");
    raiseAndAnswer(objective, task, "B");

    applyAnsweredFailureDecisions(db);

    const row = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(row.status).toBe("pending");
    expect(row.maxAttempts).toBe(task.maxAttempts + 3);
    expect(db.select().from(objectives).where(eq(objectives.id, objective.id)).get()?.status).toBe(
      "active",
    );
  });

  it('"C" (accept and continue) fails the task, cascades dependents, but lets the rest of the objective finish', () => {
    const objective = addObjective("escalate");
    const task = addTask(objective.id, "T-001");
    const dependent = addTask(objective.id, "T-002", [task.id]);
    const independent = addTask(objective.id, "T-003");
    db.update(tasks).set({ status: "done" }).where(eq(tasks.id, independent.id)).run();
    raiseAndAnswer(objective, task, "C");

    applyAnsweredFailureDecisions(db);

    expect(db.select().from(tasks).where(eq(tasks.id, task.id)).get()?.status).toBe("failed");
    expect(db.select().from(tasks).where(eq(tasks.id, dependent.id)).get()?.status).toBe("abandoned");
    // Nothing left blocked, running, pending or ready — reconcileObjective
    // lands this on "done" even though one task failed, because "C" already
    // cascaded everything that depended on it out of the way.
    expect(db.select().from(objectives).where(eq(objectives.id, objective.id)).get()?.status).toBe(
      "done",
    );
  });

  it("is idempotent: an already-applied decision is skipped on a second pass", () => {
    const objective = addObjective("escalate");
    const task = addTask(objective.id, "T-001");
    raiseAndAnswer(objective, task, "B");

    applyAnsweredFailureDecisions(db);
    const afterFirst = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;

    applyAnsweredFailureDecisions(db); // task is no longer "blocked" — must be a no-op
    const afterSecond = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(afterSecond.maxAttempts).toBe(afterFirst.maxAttempts);
  });

  it("regression: a stale, already-applied decision must never be replayed once the task fails again", () => {
    // Confirmed live: a task that kept failing the same way (e.g. a broken
    // acceptance check) got "B" answered once, then failed again and raised
    // a *second* decision, answered "A" (abandon) this time. The first
    // decision's "B" kept winning forever regardless — gating on task status
    // alone couldn't tell "already handled" apart from "blocked again for an
    // unrelated, later reason." This test is that exact two-cycle scenario.
    const objective = addObjective("escalate");
    const task = addTask(objective.id, "T-001");

    raiseAndAnswer(objective, task, "B"); // cycle 1: grant more attempts
    applyAnsweredFailureDecisions(db);
    expect(db.select().from(tasks).where(eq(tasks.id, task.id)).get()?.status).toBe("pending");

    // The task fails again (a fresh permanent failure, same task, same
    // objective) — this raises a *second*, independent L3 decision.
    const reopened = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    raiseAndAnswer(objective, reopened, "A"); // cycle 2: abandon, this time
    applyAnsweredFailureDecisions(db);

    const final = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(final.status).toBe("failed");
    expect(final.maxAttempts).toBe(reopened.maxAttempts); // not bumped again by the stale "B"
    expect(db.select().from(objectives).where(eq(objectives.id, objective.id)).get()?.status).toBe(
      "failed",
    );

    const allDecisions = db.select().from(decisions).where(eq(decisions.taskId, task.id)).all();
    expect(allDecisions).toHaveLength(2);
    expect(allDecisions.every((d) => d.appliedAt !== null)).toBe(true);
  });

  it("ignores decisions still open", () => {
    const objective = addObjective("escalate");
    const task = addTask(objective.id, "T-001");
    handlePermanentFailure(db, task, objective); // raised, but not answered

    applyAnsweredFailureDecisions(db);
    expect(db.select().from(tasks).where(eq(tasks.id, task.id)).get()?.status).toBe("blocked");
  });
});
