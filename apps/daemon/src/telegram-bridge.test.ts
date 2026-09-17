import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId } from "@exec/core";
import { appendEvent, decisions, objectives, openDb, runMigrations, tasks, type Db } from "@exec/db";
import { buildDigestSnapshot, digestHour } from "./telegram-bridge.js";

const BUDGET = { maxTurns: 40, maxTokens: 400_000, maxWallClockMs: 1_800_000 };

function addObjective(db: Db, title: string, status: string, updatedAt: number, mergedAt?: number): string {
  const id = newId();
  db.insert(objectives)
    .values({
      id, title, brief: "", repoPath: "/tmp/repo", baseRef: "HEAD",
      status, budget: BUDGET, createdAt: updatedAt, updatedAt,
      ...(mergedAt !== undefined ? { mergedAt } : {}),
    })
    .run();
  return id;
}

const ACCEPTANCE = { checks: [{ label: "tests", command: "npm test", expectExitCode: 0, timeoutMs: 60_000 }] };

let taskKeyCounter = 0;

function addTask(db: Db, objectiveId: string, title: string, status: string): string {
  const id = newId();
  taskKeyCounter += 1;
  db.insert(tasks)
    .values({
      id, objectiveId, key: `T-${taskKeyCounter}`, title, intent: title, taskClass: "implement",
      acceptance: ACCEPTANCE, dependsOn: [], status, attempts: 1, maxAttempts: 3,
      budget: BUDGET, model: "claude-sonnet-5", effort: "medium", ruledOut: [],
      createdAt: Date.now(), updatedAt: Date.now(),
    })
    .run();
  return id;
}

describe("digestHour", () => {
  const original = process.env["TELEGRAM_DIGEST_HOUR"];
  afterEach(() => {
    if (original === undefined) delete process.env["TELEGRAM_DIGEST_HOUR"];
    else process.env["TELEGRAM_DIGEST_HOUR"] = original;
  });

  it("defaults to 8am when unset", () => {
    delete process.env["TELEGRAM_DIGEST_HOUR"];
    expect(digestHour()).toBe(8);
  });

  it("honours a valid override", () => {
    process.env["TELEGRAM_DIGEST_HOUR"] = "7";
    expect(digestHour()).toBe(7);
  });

  it("falls back to the default for garbage or out-of-range input", () => {
    process.env["TELEGRAM_DIGEST_HOUR"] = "not-a-number";
    expect(digestHour()).toBe(8);
    process.env["TELEGRAM_DIGEST_HOUR"] = "24";
    expect(digestHour()).toBe(8);
    process.env["TELEGRAM_DIGEST_HOUR"] = "-1";
    expect(digestHour()).toBe(8);
  });
});

describe("buildDigestSnapshot", () => {
  let db: Db;

  beforeEach(() => {
    db = openDb({ path: ":memory:" }).db;
    runMigrations(db);
  });

  it("buckets objectives by status and only counts finished ones since the cutoff", () => {
    const now = Date.now();
    addObjective(db, "old done", "done", now - 100_000, now - 100_000);
    addObjective(db, "fresh done", "done", now - 10, now - 10);
    addObjective(db, "still going", "active", now);
    addObjective(db, "needs you", "blocked", now);
    addObjective(db, "rate limited", "parked", now);

    const snapshot = buildDigestSnapshot(db, now - 1000);

    expect(snapshot.finishedSinceLast).toEqual(["fresh done (done)"]);
    expect(snapshot.active).toEqual(["still going"]);
    expect(snapshot.blocked).toEqual(["needs you"]);
    expect(snapshot.parked).toEqual(["rate limited"]);
  });

  it("returns empty sections and undefined health when there is nothing to report", () => {
    const snapshot = buildDigestSnapshot(db, Date.now());
    expect(snapshot).toEqual({
      finishedSinceLast: [],
      active: [],
      blocked: [],
      parked: [],
      recovered: [],
      decisionsNeeded: [],
      readyToMerge: [],
      health: { buildPct: undefined, testsPct: undefined, securityPct: undefined },
    });
  });

  it("reports a task as recovered only once it actually reached done, not while still failing", () => {
    const now = Date.now();
    const objId = addObjective(db, "obj", "active", now);
    const recoveredTaskId = addTask(db, objId, "recovered task", "done");
    const stillFailingTaskId = addTask(db, objId, "still stuck", "blocked");

    appendEvent(db, {
      objectiveId: objId,
      taskId: recoveredTaskId,
      payload: { type: "diagnose.result", cause: "budget too tight", class: "flaky", nextAction: "retry" },
    });
    appendEvent(db, {
      objectiveId: objId,
      taskId: stillFailingTaskId,
      payload: { type: "diagnose.result", cause: "broken spec", class: "spec", nextAction: "escalate" },
    });

    const snapshot = buildDigestSnapshot(db, now - 1000);

    expect(snapshot.recovered).toEqual([
      { taskTitle: "recovered task", cause: "budget too tight", class: "flaky" },
    ]);
  });

  it("resolves an open decision's recommendation to its actual option label", () => {
    const objId = addObjective(db, "obj", "blocked", Date.now());
    db.insert(decisions)
      .values({
        id: newId(), key: "DEC-001", objectiveId: objId, level: "L3",
        title: "Database architecture", context: "ctx",
        options: [{ id: "A", label: "MongoDB", pros: [], cons: [] }, { id: "B", label: "PostgreSQL + RLS", pros: [], cons: [] }],
        recommendation: "B", risk: "medium", status: "open", createdAt: Date.now(),
      })
      .run();

    const snapshot = buildDigestSnapshot(db, Date.now() - 1000);

    expect(snapshot.decisionsNeeded).toEqual([
      { key: "DEC-001", title: "Database architecture", recommendationLabel: "PostgreSQL + RLS" },
    ]);
  });

  it("lists a done-but-unmerged objective as ready to merge, and excludes an already-merged one", () => {
    addObjective(db, "done, unmerged", "done", Date.now());
    addObjective(db, "done, merged", "done", Date.now(), Date.now());

    const snapshot = buildDigestSnapshot(db, Date.now() - 1000);

    expect(snapshot.readyToMerge).toEqual(["done, unmerged"]);
  });
});
