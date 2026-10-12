import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { newId } from "@exec/core";
import { objectives, openDb, readEvents, runMigrations, runs, tasks, tryAcquireApproveLock, type Db } from "@exec/db";
import type { MultiMergeResult } from "@exec/worker";
import { APP_APPROVED_BY, mergeForApp, processMerges, scrubPaths, type MergeGit, type MergeInbox } from "./merge.js";

const BUDGET = { maxTurns: 1, maxTokens: 1, maxWallClockMs: 1 };
const REPO = "C:\\Users\\jawid\\Desktop\\takil-workspace";
let db: Db;
let objectiveId: string;

function gitThat(result: Partial<MultiMergeResult> & { diff?: string } = {}): MergeGit & { merged: number } {
  const fake = {
    merged: 0,
    diffs: (_t: unknown, branches: string[]) => branches.map((branch) => ({ branch, diff: result.diff ?? "+ a line" })),
    merge: (_t: unknown, branches: string[]): MultiMergeResult => {
      fake.merged += 1;
      return {
        baseBranch: "main",
        allMerged: true,
        pushed: true,
        message: "Merged 1 branch into main and pushed.",
        branches: branches.map((branch) => ({ branch, merged: true, message: "ok" })),
        ...result,
      };
    },
  };
  return fake;
}

beforeEach(() => {
  db = openDb({ path: ":memory:" }).db;
  runMigrations(db);
  objectiveId = newId();
  const taskId = newId();
  db.insert(objectives).values({ id: objectiveId, title: "o", repoPath: REPO, budget: BUDGET, status: "done" }).run();
  db.insert(tasks)
    .values({
      id: taskId, objectiveId, key: "T-001", title: "t", intent: "x", taskClass: "implement",
      acceptance: { checks: [] }, budget: BUDGET, status: "done", attempts: 1,
    })
    .run();
  db.insert(runs)
    .values({
      id: newId(), taskId, objectiveId, attempt: 1, sessionId: newId(), model: "m", worktreePath: "/w",
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, status: "completed",
    })
    .run();
});

const objective = () => db.select().from(objectives).where(eq(objectives.id, objectiveId)).get()!;

describe("mergeForApp", () => {
  it("merges, marks the objective merged, and records who approved it", () => {
    const git = gitThat();
    expect(mergeForApp(db, objectiveId, git)).toMatchObject({ status: "merged", pushed: true });
    expect(objective().mergedAt).not.toBeNull();
    const approved = readEvents(db, { objectiveId }).find((e) => e.payload.type === "objective.approved");
    expect(approved?.payload).toMatchObject({ approvedBy: APP_APPROVED_BY, baseRef: "main" });
  });

  it("reports an already-merged objective as merged without merging again (crash-safe retry)", () => {
    const git = gitThat();
    mergeForApp(db, objectiveId, git);
    expect(mergeForApp(db, objectiveId, git)).toMatchObject({ status: "merged", message: "Already merged." });
    expect(git.merged).toBe(1);
  });

  it("explains a conflict using the failing branch's own message", () => {
    const git = gitThat({
      allMerged: false,
      pushed: false,
      message: "Nothing merged.",
      branches: [{ branch: "exec/x-attempt-1", merged: false, message: "Merge failed: CONFLICT in README.md" }],
    });
    expect(mergeForApp(db, objectiveId, git)).toMatchObject({ status: "failed", message: "Merge failed: CONFLICT in README.md" });
    expect(objective().mergedAt).toBeNull();
  });

  it("never sends this machine's paths to the phone", () => {
    const git = gitThat({
      allMerged: false,
      branches: [{ branch: "b", merged: false, message: `${REPO} has uncommitted changes — commit or stash them` }],
    });
    const { message } = mergeForApp(db, objectiveId, git);
    expect(message).toBe("takil-workspace has uncommitted changes — commit or stash them");
    expect(message).not.toContain("Users");
  });

  it("refuses when there is nothing to merge", () => {
    expect(mergeForApp(db, objectiveId, gitThat({ diff: "" }))).toMatchObject({ status: "failed" });
  });

  it("refuses while the dashboard or CLI is already merging it", () => {
    tryAcquireApproveLock(db, objectiveId, "dashboard");
    const git = gitThat();
    expect(mergeForApp(db, objectiveId, git).message).toMatch(/already being merged elsewhere \(dashboard\)/);
    expect(git.merged).toBe(0);
  });

  it("refuses an objective that isn't finished", () => {
    db.update(objectives).set({ status: "active" }).run();
    expect(mergeForApp(db, objectiveId, gitThat()).message).toMatch(/isn’t finished/);
  });

  it("refuses an objective that isn't on this computer", () => {
    expect(mergeForApp(db, "nope", gitThat()).status).toBe("failed");
  });

  it("releases the lock even when git throws", () => {
    const git: MergeGit = { diffs: gitThat().diffs, merge: () => { throw new Error("boom"); } };
    expect(mergeForApp(db, objectiveId, git)).toMatchObject({ status: "failed", message: "The merge stopped: boom" });
    expect(tryAcquireApproveLock(db, objectiveId, "cli").acquired).toBe(true);
  });
});

describe("scrubPaths", () => {
  it("replaces the repo path in either slash style, any case", () => {
    expect(scrubPaths("c:/users/jawid/desktop/takil-workspace is dirty", REPO)).toBe("takil-workspace is dirty");
  });
});

describe("processMerges", () => {
  it("settles each pending merge with its outcome", async () => {
    const settled: unknown[] = [];
    const inbox: MergeInbox = {
      pending: async () => [{ id: "m1", objective_id: objectiveId }],
      settle: async (...args) => {
        settled.push(args);
      },
    };
    expect(await processMerges(db, inbox, gitThat())).toBe(1);
    expect(settled).toEqual([["m1", "merged", "Merged 1 branch into main and pushed.", true]]);
  });
});
