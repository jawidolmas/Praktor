import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "./worktree.js";
import {
  computeApprovalDiff,
  computeApprovalDiffs,
  isRepoClean,
  mergeAndPushAll,
  resolveBaseBranch,
} from "./approve.js";

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "approve-test-"));
  git(repoPath, ["init", "-q", "-b", "main"]);
  git(repoPath, ["config", "user.email", "test@example.com"]);
  git(repoPath, ["config", "user.name", "Test"]);
  writeFileSync(join(repoPath, "README.md"), "hello\n");
  git(repoPath, ["add", "-A"]);
  git(repoPath, ["commit", "-q", "-m", "init"]);
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

/** Simulates what the daemon does in a worktree: a branch off main with one
 *  extra commit — without an actual `git worktree add`, since these tests
 *  only care about the merge-back step, not worktree creation. */
function createAcceptedBranch(branch: string): void {
  createBranchWithFile(branch, "NEW.md", "worker's change\n");
}

/** Like `createAcceptedBranch`, but lets a test control which file gets
 *  written — used to set up two independent task branches that each touch a
 *  different file (a real multi-task decomposition) or the same file with
 *  different content (a merge conflict between two accepted branches). */
function createBranchWithFile(branch: string, filename: string, content: string): void {
  git(repoPath, ["checkout", "-q", "-b", branch]);
  writeFileSync(join(repoPath, filename), content);
  git(repoPath, ["add", "-A"]);
  git(repoPath, ["commit", "-q", "-m", `add ${filename}`]);
  git(repoPath, ["checkout", "-q", "main"]);
}

describe("resolveBaseBranch", () => {
  it("resolves the literal HEAD to the real checked-out branch name", () => {
    expect(resolveBaseBranch(repoPath, "HEAD")).toBe("main");
  });

  it("passes an explicit branch name through unchanged", () => {
    expect(resolveBaseBranch(repoPath, "main")).toBe("main");
  });

  it("returns HEAD back out for a detached HEAD, signalling no named branch", () => {
    const sha = git(repoPath, ["rev-parse", "HEAD"]);
    git(repoPath, ["checkout", "-q", sha]);
    expect(resolveBaseBranch(repoPath, "HEAD")).toBe("HEAD");
  });
});

describe("isRepoClean", () => {
  it("is true for a freshly committed repo", () => {
    expect(isRepoClean(repoPath)).toBe(true);
  });

  it("is false with an uncommitted change", () => {
    writeFileSync(join(repoPath, "dirty.md"), "oops");
    expect(isRepoClean(repoPath)).toBe(false);
  });
});

describe("computeApprovalDiff", () => {
  it("shows the accepted branch's change against the resolved base", () => {
    createAcceptedBranch("exec/task1-attempt-1");
    const diff = computeApprovalDiff({ repoPath, baseRef: "HEAD", branch: "exec/task1-attempt-1" });
    expect(diff).toContain("NEW.md");
    expect(diff).toContain("worker's change");
  });
});

describe("computeApprovalDiffs", () => {
  it("returns one diff per branch, each against the same resolved base — the multi-task case", () => {
    createAcceptedBranch("exec/d1-attempt-1");
    createBranchWithFile("exec/d2-attempt-1", "OTHER.md", "second task's change\n");

    const diffs = computeApprovalDiffs({ repoPath, baseRef: "HEAD" }, ["exec/d1-attempt-1", "exec/d2-attempt-1"]);

    expect(diffs).toHaveLength(2);
    expect(diffs[0]).toMatchObject({ branch: "exec/d1-attempt-1" });
    expect(diffs[0]!.diff).toContain("NEW.md");
    expect(diffs[1]).toMatchObject({ branch: "exec/d2-attempt-1" });
    expect(diffs[1]!.diff).toContain("OTHER.md");
  });
});

describe("mergeAndPushAll", () => {
  it("merges a single accepted branch into the resolved base branch", () => {
    createAcceptedBranch("exec/task2-attempt-1");
    const result = mergeAndPushAll({ repoPath, baseRef: "HEAD" }, ["exec/task2-attempt-1"]);

    expect(result.allMerged).toBe(true);
    expect(result.baseBranch).toBe("main");
    // No remote configured in this throwaway repo, so push is expected to fail —
    // that must not undo the already-successful local merge.
    expect(result.pushed).toBe(false);

    expect(git(repoPath, ["log", "-1", "--format=%s"])).toContain("exec/task2-attempt-1");
    const files = git(repoPath, ["ls-files"]);
    expect(files).toContain("NEW.md");
  });

  it("merges every accepted branch from a multi-task objective, in order, before pushing once", () => {
    createAcceptedBranch("exec/multi1-attempt-1");
    createBranchWithFile("exec/multi2-attempt-1", "SECOND.md", "second task's change\n");

    const result = mergeAndPushAll({ repoPath, baseRef: "HEAD" }, [
      "exec/multi1-attempt-1",
      "exec/multi2-attempt-1",
    ]);

    expect(result.allMerged).toBe(true);
    expect(result.branches.map((b) => ({ branch: b.branch, merged: b.merged }))).toEqual([
      { branch: "exec/multi1-attempt-1", merged: true },
      { branch: "exec/multi2-attempt-1", merged: true },
    ]);
    const files = git(repoPath, ["ls-files"]);
    expect(files).toContain("NEW.md");
    expect(files).toContain("SECOND.md");
  });

  it("stops at the first branch that fails to merge, keeps what already merged, and skips the rest", () => {
    createBranchWithFile("exec/c1-attempt-1", "CONFLICT.md", "first version\n");
    createBranchWithFile("exec/c2-attempt-1", "CONFLICT.md", "second, conflicting version\n");
    createAcceptedBranch("exec/c3-attempt-1"); // unrelated file — never reached

    const result = mergeAndPushAll({ repoPath, baseRef: "HEAD" }, [
      "exec/c1-attempt-1",
      "exec/c2-attempt-1",
      "exec/c3-attempt-1",
    ]);

    expect(result.allMerged).toBe(false);
    expect(result.branches[0]).toMatchObject({ branch: "exec/c1-attempt-1", merged: true });
    expect(result.branches[1]!.merged).toBe(false);
    expect(result.branches[1]!.message).toMatch(/merge failed/i);
    expect(result.branches[2]).toMatchObject({
      branch: "exec/c3-attempt-1",
      merged: false,
      message: expect.stringMatching(/skipped/i),
    });

    // c1's change is real and must not be rolled back just because c2
    // conflicted — real git leaves the conflict markers in place rather than
    // reverting, so there is something concrete for a person to resolve.
    expect(readFileSync(join(repoPath, "CONFLICT.md"), "utf8")).toContain("first version");
    expect(readFileSync(join(repoPath, "CONFLICT.md"), "utf8")).toContain("second, conflicting version");
    // c3 was never even attempted, so its file must not be present.
    const files = git(repoPath, ["ls-files"]);
    expect(files).not.toContain("NEW.md");
    // The repo is left mid-conflict, not silently "clean" — a careless
    // re-approve must see this and refuse rather than merging on top of it.
    expect(isRepoClean(repoPath)).toBe(false);
  });

  it("refuses to merge any branch when the real repo has uncommitted changes", () => {
    createAcceptedBranch("exec/task3-attempt-1");
    writeFileSync(join(repoPath, "uncommitted.md"), "don't clobber me");

    const result = mergeAndPushAll({ repoPath, baseRef: "HEAD" }, ["exec/task3-attempt-1"]);

    expect(result.allMerged).toBe(false);
    expect(result.message).toMatch(/uncommitted/i);
    // The unrelated dirty file must still be there, untouched.
    expect(isRepoClean(repoPath)).toBe(false);
  });

  it("refuses to merge from a detached HEAD, since there is no branch to merge into", () => {
    createAcceptedBranch("exec/task4-attempt-1");
    const sha = git(repoPath, ["rev-parse", "main"]);
    git(repoPath, ["checkout", "-q", sha]);

    const result = mergeAndPushAll({ repoPath, baseRef: "HEAD" }, ["exec/task4-attempt-1"]);

    expect(result.allMerged).toBe(false);
    expect(result.message).toMatch(/detached/i);
  });

  it("is idempotent across multiple branches — re-approving already-merged branches is a harmless no-op", () => {
    createAcceptedBranch("exec/task5-attempt-1");
    createBranchWithFile("exec/task6-attempt-1", "IDEMPOTENT.md", "second task's change\n");
    mergeAndPushAll({ repoPath, baseRef: "HEAD" }, ["exec/task5-attempt-1", "exec/task6-attempt-1"]);

    const second = mergeAndPushAll({ repoPath, baseRef: "HEAD" }, ["exec/task5-attempt-1", "exec/task6-attempt-1"]);
    expect(second.allMerged).toBe(true);
  });
});
