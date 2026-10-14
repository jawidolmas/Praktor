import { eq } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newId } from "@exec/core";
import { objectives, openDb, runMigrations, runs, tasks, type Db } from "@exec/db";
import { attemptBranchName } from "@exec/worker";
import { agentFilesFor, changedFileCount, parseNameStatusZ, recordChangedFiles } from "./agent-files.js";

describe("parseNameStatusZ", () => {
  it("parses plain changes and renames, including paths with spaces", () => {
    expect(parseNameStatusZ("M\0src/a.ts\0R087\0old.ts\0new.ts\0A\0b c.ts\0")).toEqual([
      { status: "M", path: "src/a.ts" },
      { status: "R", path: "new.ts", oldPath: "old.ts" },
      { status: "A", path: "b c.ts" },
    ]);
  });
});

describe("agentFilesFor", () => {
  const budget = { maxTurns: 1, maxTokens: 1, maxWallClockMs: 1 };
  let repo: string;
  let db: Db;

  function git(...args: string[]): void {
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
  }

  function seed(attempt: number | undefined): { objectiveId: string; taskId: string } {
    const objectiveId = newId();
    const taskId = newId();
    db.insert(objectives).values({ id: objectiveId, title: "o", repoPath: repo, baseRef: "main", budget }).run();
    db.insert(tasks)
      .values({
        id: taskId, objectiveId, key: "T-001", title: "t", intent: "x", taskClass: "implement",
        acceptance: { checks: [] }, budget,
      })
      .run();
    if (attempt !== undefined) {
      db.insert(runs)
        .values({
          id: newId(), taskId, objectiveId, attempt, sessionId: newId(), model: "m", worktreePath: "/w",
          usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        })
        .run();
    }
    return { objectiveId, taskId };
  }

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "praktor-files-"));
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    writeFileSync(join(repo, "README.md"), "hi\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  beforeEach(() => {
    db = openDb({ path: ":memory:" }).db;
    runMigrations(db);
  });

  it("lists what the latest attempt changed against the base", () => {
    const { objectiveId, taskId } = seed(2);
    const branch = attemptBranchName(taskId, 2);
    git("checkout", "-q", "-b", branch);
    writeFileSync(join(repo, "feature.ts"), "export {}\n");
    writeFileSync(join(repo, "README.md"), "changed\n");
    git("add", ".");
    git("commit", "-q", "-m", "work");
    git("checkout", "-q", "main");

    const [files] = agentFilesFor(db, objectiveId);
    expect(files).toMatchObject({ taskId, attempt: 2, branch, available: true, truncated: false });
    expect(files!.changes).toEqual(
      expect.arrayContaining([
        { status: "A", path: "feature.ts" },
        { status: "M", path: "README.md" },
      ]),
    );
  });

  it("keeps the file list after the branch is gone, from what was recorded at acceptance", () => {
    const { objectiveId, taskId } = seed(1);
    const branch = attemptBranchName(taskId, 1);
    const baseSha = execFileSync("git", ["-C", repo, "rev-parse", "main"], { encoding: "utf8" }).trim();
    git("checkout", "-q", "-b", branch);
    writeFileSync(join(repo, "kept.ts"), "export {}\n");
    git("add", ".");
    git("commit", "-q", "-m", "work");

    // Recorded from the attempt's worktree (here, the repo on its branch).
    expect(recordChangedFiles(db, { objectiveId, taskId, runId: "r1", attempt: 1, worktreePath: repo, baseSha })).toBe(true);

    // The branch is merged and cleaned up — nothing left to diff.
    git("checkout", "-q", "main");
    git("branch", "-q", "-D", branch);

    const [files] = agentFilesFor(db, objectiveId);
    expect(files).toMatchObject({ available: true, attempt: 1 });
    expect(files!.changes).toEqual([{ status: "A", path: "kept.ts" }]);
  });

  it("never uses a record from a different attempt", () => {
    const { objectiveId, taskId } = seed(2);
    const baseSha = execFileSync("git", ["-C", repo, "rev-parse", "main"], { encoding: "utf8" }).trim();
    recordChangedFiles(db, { objectiveId, taskId, runId: "r1", attempt: 1, worktreePath: repo, baseSha });
    expect(agentFilesFor(db, objectiveId)[0]).toMatchObject({ available: false });
  });

  it("counts zero changed files as zero — and unknown as null, never as zero", () => {
    const { objectiveId, taskId } = seed(1);
    db.update(tasks).set({ status: "done" }).where(eq(tasks.id, taskId)).run();
    // No record yet: unknown, so the app still offers a merge.
    expect(changedFileCount(db, objectiveId)).toBeNull();

    const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    recordChangedFiles(db, { objectiveId, taskId, runId: "r", attempt: 1, worktreePath: repo, baseSha: head });
    // A record of an attempt that changed nothing: genuinely nothing to merge.
    expect(changedFileCount(db, objectiveId)).toBe(0);
  });

  it("never throws when recording fails", () => {
    expect(
      recordChangedFiles(db, { objectiveId: "o", taskId: "t", runId: "r", attempt: 1, worktreePath: "/no/such/dir", baseSha: "HEAD" }),
    ).toBe(false);
  });

  it("reports a branch that no longer exists as unavailable", () => {
    const { objectiveId } = seed(1);
    expect(agentFilesFor(db, objectiveId)).toEqual([expect.objectContaining({ available: false, changes: [] })]);
  });

  it("skips tasks that never started", () => {
    const { objectiveId } = seed(undefined);
    expect(agentFilesFor(db, objectiveId)).toEqual([]);
  });
});
