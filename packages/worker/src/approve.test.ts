import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "./worktree.js";
import { computeApprovalDiff, isRepoClean, mergeAndPush, resolveBaseBranch } from "./approve.js";

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
  git(repoPath, ["checkout", "-q", "-b", branch]);
  writeFileSync(join(repoPath, "NEW.md"), "worker's change\n");
  git(repoPath, ["add", "-A"]);
  git(repoPath, ["commit", "-q", "-m", "worker commit"]);
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

describe("mergeAndPush", () => {
  it("merges the accepted branch into the resolved base branch", () => {
    createAcceptedBranch("exec/task2-attempt-1");
    const result = mergeAndPush({ repoPath, baseRef: "HEAD", branch: "exec/task2-attempt-1" });

    expect(result.merged).toBe(true);
    expect(result.baseBranch).toBe("main");
    // No remote configured in this throwaway repo, so push is expected to fail —
    // that must not undo the already-successful local merge.
    expect(result.pushed).toBe(false);

    expect(git(repoPath, ["log", "-1", "--format=%s"])).toContain("exec/task2-attempt-1");
    const files = git(repoPath, ["ls-files"]);
    expect(files).toContain("NEW.md");
  });

  it("refuses to merge when the real repo has uncommitted changes", () => {
    createAcceptedBranch("exec/task3-attempt-1");
    writeFileSync(join(repoPath, "uncommitted.md"), "don't clobber me");

    const result = mergeAndPush({ repoPath, baseRef: "HEAD", branch: "exec/task3-attempt-1" });

    expect(result.merged).toBe(false);
    expect(result.message).toMatch(/uncommitted/i);
    // The unrelated dirty file must still be there, untouched.
    expect(isRepoClean(repoPath)).toBe(false);
  });

  it("refuses to merge from a detached HEAD, since there is no branch to merge into", () => {
    createAcceptedBranch("exec/task4-attempt-1");
    const sha = git(repoPath, ["rev-parse", "main"]);
    git(repoPath, ["checkout", "-q", sha]);

    const result = mergeAndPush({ repoPath, baseRef: "HEAD", branch: "exec/task4-attempt-1" });

    expect(result.merged).toBe(false);
    expect(result.message).toMatch(/detached/i);
  });

  it("is idempotent — approving an already-merged branch again is a harmless no-op merge", () => {
    createAcceptedBranch("exec/task5-attempt-1");
    mergeAndPush({ repoPath, baseRef: "HEAD", branch: "exec/task5-attempt-1" });

    const second = mergeAndPush({ repoPath, baseRef: "HEAD", branch: "exec/task5-attempt-1" });
    expect(second.merged).toBe(true);
  });
});
