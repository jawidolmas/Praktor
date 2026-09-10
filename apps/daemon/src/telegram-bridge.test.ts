import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId } from "@exec/core";
import { objectives, openDb, runMigrations, type Db } from "@exec/db";
import { buildDigestSnapshot, digestHour } from "./telegram-bridge.js";

const BUDGET = { maxTurns: 40, maxTokens: 400_000, maxWallClockMs: 1_800_000 };

function addObjective(db: Db, title: string, status: string, updatedAt: number): void {
  db.insert(objectives)
    .values({
      id: newId(), title, brief: "", repoPath: "/tmp/repo", baseRef: "HEAD",
      status, budget: BUDGET, createdAt: updatedAt, updatedAt,
    })
    .run();
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
    addObjective(db, "old done", "done", now - 100_000);
    addObjective(db, "fresh done", "done", now - 10);
    addObjective(db, "still going", "active", now);
    addObjective(db, "needs you", "blocked", now);
    addObjective(db, "rate limited", "parked", now);

    const snapshot = buildDigestSnapshot(db, now - 1000);

    expect(snapshot.finishedSinceLast).toEqual(["fresh done (done)"]);
    expect(snapshot.active).toEqual(["still going"]);
    expect(snapshot.blocked).toEqual(["needs you"]);
    expect(snapshot.parked).toEqual(["rate limited"]);
  });

  it("returns empty sections when there is nothing to report", () => {
    const snapshot = buildDigestSnapshot(db, Date.now());
    expect(snapshot).toEqual({ finishedSinceLast: [], active: [], blocked: [], parked: [] });
  });
});
