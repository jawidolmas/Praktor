import { eq } from "drizzle-orm";
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
import { applyAnsweredFailureDecisions, clampParkDelay, handlePermanentFailure } from "./engine.js";

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

  it("abandon: fails the task, cascades dependents, and fails the objective immediately", () => {
    const objective = addObjective("abandon");
    const task = addTask(objective.id, "T-001");
    const dependent = addTask(objective.id, "T-002", [task.id]);

    handlePermanentFailure(db, task, objective);

    expect(db.select().from(tasks).where(eq(tasks.id, task.id)).get()?.status).toBe("failed");
    expect(db.select().from(tasks).where(eq(tasks.id, dependent.id)).get()?.status).toBe("abandoned");
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
    const raised = db.select().from(decisions).where(eq(decisions.taskId, task.id)).get()!;
    db.update(decisions)
      .set({ status: "answered", answer, answeredBy: "ceo", answeredAt: Date.now() })
      .where(eq(decisions.id, raised.id))
      .run();
  }

  it('"A" (abandon) fails the task, cascades dependents, and fails the objective', () => {
    const objective = addObjective("escalate");
    const task = addTask(objective.id, "T-001");
    const dependent = addTask(objective.id, "T-002", [task.id]);
    raiseAndAnswer(objective, task, "A");

    applyAnsweredFailureDecisions(db);

    expect(db.select().from(tasks).where(eq(tasks.id, task.id)).get()?.status).toBe("failed");
    expect(db.select().from(tasks).where(eq(tasks.id, dependent.id)).get()?.status).toBe("abandoned");
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

  it("ignores decisions still open", () => {
    const objective = addObjective("escalate");
    const task = addTask(objective.id, "T-001");
    handlePermanentFailure(db, task, objective); // raised, but not answered

    applyAnsweredFailureDecisions(db);
    expect(db.select().from(tasks).where(eq(tasks.id, task.id)).get()?.status).toBe("blocked");
  });
});
