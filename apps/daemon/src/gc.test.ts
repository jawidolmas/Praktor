import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId } from "@exec/core";
import { objectives, openDb, runMigrations, tasks, type Db, type ObjectiveRow, type TaskRow } from "@exec/db";
import { createWorktree, git } from "@exec/worker";
import { parseWorktreeDirName, reclaimWorktrees, shouldReclaimWorktree } from "./gc.js";

describe("parseWorktreeDirName", () => {
  it("splits on the last hyphen, since a taskId is itself a hyphenated uuid", () => {
    expect(parseWorktreeDirName("a1b2c3d4-e5f6-7890-abcd-ef0123456789-3")).toEqual({
      taskId: "a1b2c3d4-e5f6-7890-abcd-ef0123456789",
      attempt: 3,
    });
  });

  it("rejects a name with no trailing attempt number", () => {
    expect(parseWorktreeDirName("not-a-worktree-dir")).toBeUndefined();
  });

  it("rejects a bare number with nothing before it", () => {
    expect(parseWorktreeDirName("-1")).toBeUndefined();
  });
});

describe("shouldReclaimWorktree", () => {
  const base = { taskStatus: "running", taskCurrentAttempts: 2, objectiveStatus: "active", objectiveMergedAt: null, attempt: 3 };

  it("reclaims an attempt older than the task's current one, regardless of status", () => {
    expect(shouldReclaimWorktree({ ...base, attempt: 1, taskCurrentAttempts: 2 })).toBe(true);
  });

  it("keeps the current in-flight attempt of a still-active task", () => {
    expect(shouldReclaimWorktree({ ...base, attempt: 3, taskCurrentAttempts: 2, taskStatus: "running" })).toBe(false);
  });

  it("reclaims a failed task's worktree even while the objective is still active", () => {
    // The gap this exists for: a daemon crash mid-attempt, later resolved by
    // an L3 decision that never goes through driveTask's own cleanup.
    expect(shouldReclaimWorktree({ ...base, taskStatus: "failed", objectiveStatus: "active" })).toBe(true);
  });

  it("reclaims an abandoned task's worktree", () => {
    expect(shouldReclaimWorktree({ ...base, taskStatus: "abandoned" })).toBe(true);
  });

  it("keeps a done task's worktree while the objective is unmerged — approve needs it", () => {
    expect(shouldReclaimWorktree({ ...base, taskStatus: "done", objectiveStatus: "done", objectiveMergedAt: null })).toBe(false);
  });

  it("reclaims a done task's worktree once the objective is merged", () => {
    expect(shouldReclaimWorktree({ ...base, taskStatus: "done", objectiveStatus: "done", objectiveMergedAt: Date.now() })).toBe(true);
  });

  it("reclaims everything once the objective has failed outright", () => {
    expect(shouldReclaimWorktree({ ...base, taskStatus: "done", objectiveStatus: "failed" })).toBe(true);
  });

  it("reclaims everything once the objective was cancelled", () => {
    expect(shouldReclaimWorktree({ ...base, taskStatus: "blocked", objectiveStatus: "cancelled" })).toBe(true);
  });

  it("keeps a blocked task's worktree — a live decision may still resume it", () => {
    expect(shouldReclaimWorktree({ ...base, taskStatus: "blocked", objectiveStatus: "blocked" })).toBe(false);
  });
});

describe("reclaimWorktrees", () => {
  let db: Db;
  let repoPath: string;
  let worktreesDir: string;

  const BUDGET = { maxTurns: 40, maxTokens: 400_000, maxWallClockMs: 1_800_000 };
  const ACCEPTANCE = { checks: [{ label: "tests", command: "true", expectExitCode: 0, timeoutMs: 60_000 }] };

  function addObjective(status: string, mergedAt: number | null = null): ObjectiveRow {
    const id = newId();
    db.insert(objectives)
      .values({
        id, title: "t", brief: "", repoPath, baseRef: "HEAD", status,
        budget: BUDGET, mergedAt, createdAt: Date.now(), updatedAt: Date.now(),
      })
      .run();
    return db.select().from(objectives).where(eq(objectives.id, id)).get()!;
  }

  function addTask(objectiveId: string, status: string, attempts: number): TaskRow {
    const id = newId();
    db.insert(tasks)
      .values({
        id, objectiveId, key: "T-001", title: "t", intent: "t", taskClass: "implement",
        acceptance: ACCEPTANCE, dependsOn: [], status, attempts, maxAttempts: 3,
        budget: BUDGET, model: "claude-sonnet-5", effort: "medium", ruledOut: [],
        createdAt: Date.now(), updatedAt: Date.now(),
      })
      .run();
    return db.select().from(tasks).where(eq(tasks.id, id)).get()!;
  }

  function makeWorktree(taskId: string, attempt: number): string {
    const path = join(worktreesDir, `${taskId}-${attempt}`);
    createWorktree({ repoPath, worktreePath: path, branch: `exec/${taskId.slice(0, 8)}-attempt-${attempt}`, baseRef: "HEAD" });
    return path;
  }

  beforeEach(() => {
    db = openDb({ path: ":memory:" }).db;
    runMigrations(db);
    repoPath = mkdtempSync(join(tmpdir(), "gc-repo-"));
    git(repoPath, ["init", "-q", "-b", "main"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "user.name", "Test"]);
    writeFileSync(join(repoPath, "README.md"), "hello\n");
    git(repoPath, ["add", "-A"]);
    git(repoPath, ["commit", "-q", "-m", "init"]);
    worktreesDir = mkdtempSync(join(tmpdir(), "gc-worktrees-"));
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
    rmSync(worktreesDir, { recursive: true, force: true });
  });

  it("does nothing when the worktrees directory doesn't exist yet", () => {
    rmSync(worktreesDir, { recursive: true, force: true });
    expect(reclaimWorktrees(db, worktreesDir)).toEqual({ removed: 0, kept: 0 });
  });

  it("removes a merged objective's worktree from disk and keeps an unmerged one", () => {
    const merged = addObjective("done", Date.now());
    const mergedTask = addTask(merged.id, "done", 1);
    const mergedPath = makeWorktree(mergedTask.id, 1);

    const unmerged = addObjective("done", null);
    const unmergedTask = addTask(unmerged.id, "done", 1);
    const unmergedPath = makeWorktree(unmergedTask.id, 1);

    const result = reclaimWorktrees(db, worktreesDir);

    expect(result).toEqual({ removed: 1, kept: 1 });
    expect(existsSync(mergedPath)).toBe(false);
    expect(existsSync(unmergedPath)).toBe(true);
  });

  it("removes a failed task's leftover worktree even though the objective is still active", () => {
    const objective = addObjective("active");
    const task = addTask(objective.id, "failed", 1);
    const path = makeWorktree(task.id, 2); // the crashed, never-cleaned attempt

    reclaimWorktrees(db, worktreesDir);

    expect(existsSync(path)).toBe(false);
  });

  it("always removes a leaked integration-branch scratch worktree, regardless of the objective's status — a crash mid-fold is the only way one is ever seen here", () => {
    const objective = addObjective("active");
    const path = join(worktreesDir, `${objective.id}-integration-scratch`);
    mkdirSync(path, { recursive: true });

    const result = reclaimWorktrees(db, worktreesDir);

    expect(result.removed).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  it("leaves a directory it can't confidently place — no matching task row — untouched by default reclaim rules, only removing it because nothing references it", () => {
    const orphanId = newId();
    const path = join(worktreesDir, `${orphanId}-1`);
    mkdirSync(path, { recursive: true });

    const result = reclaimWorktrees(db, worktreesDir);

    // No task row anywhere in the database for this id — nothing will ever
    // reference it again, so it's reclaimed rather than left as permanent cruft.
    expect(result.removed).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  it("ignores a directory that doesn't match the taskId-attempt naming convention", () => {
    const path = join(worktreesDir, "not-one-of-ours");
    mkdirSync(path, { recursive: true });

    const result = reclaimWorktrees(db, worktreesDir);

    expect(result).toEqual({ removed: 0, kept: 0 });
    expect(existsSync(path)).toBe(true);
  });
});
