import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorktree, diffPatch, git, removeWorktree } from "./worktree.js";

let repoPath: string;
let worktreePath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "worktree-test-"));
  worktreePath = join(mkdtempSync(join(tmpdir(), "worktree-test-out-")), "wt");
  git(repoPath, ["init", "-q", "-b", "main"]);
  git(repoPath, ["config", "user.email", "test@example.com"]);
  git(repoPath, ["config", "user.name", "Test"]);
  // Simulates the (common, Windows-default) case where the repo — or the
  // machine's global git config, which has the same effect — auto-converts
  // line endings on checkout. Setting it on this test repo, rather than the
  // real global config, is what keeps the test from touching anything outside
  // its own throwaway directory.
  git(repoPath, ["config", "core.autocrlf", "true"]);
  writeFileSync(join(repoPath, "reference.txt"), "line one\nline two\n");
  git(repoPath, ["add", "-A"]);
  git(repoPath, ["commit", "-q", "-m", "init"]);
});

afterEach(() => {
  try {
    removeWorktree({ repoPath, path: worktreePath, branch: "n/a", baseSha: "n/a" });
  } catch {
    /* best effort */
  }
  rmSync(repoPath, { recursive: true, force: true });
  rmSync(worktreePath, { recursive: true, force: true });
});

describe("createWorktree", () => {
  it("checks files out with their committed line endings, regardless of core.autocrlf", () => {
    // Regression: without a per-checkout override, a repo (or machine) with
    // core.autocrlf=true checks this out with CRLF line endings even though
    // the committed blob — and anything a worker's own editing tools write
    // fresh — is plain LF. An acceptance check that diffs the two byte-for-byte
    // (a real, previously-seen pattern) then fails on content that is
    // otherwise identical, purely from that mismatch.
    createWorktree({ repoPath, worktreePath, branch: "exec/test-attempt-1", baseRef: "HEAD" });

    const raw = readFileSync(join(worktreePath, "reference.txt"));
    expect(raw.includes(0x0d)).toBe(false); // no CR byte anywhere
    expect(raw.toString("utf8")).toBe("line one\nline two\n");
  });
});

describe("diffPatch", () => {
  it("returns real hunk content, not just a file/line summary", () => {
    const handle = createWorktree({ repoPath, worktreePath, branch: "exec/test-attempt-1", baseRef: "HEAD" });
    writeFileSync(join(worktreePath, "reference.txt"), "line one\nline two changed\n");
    git(worktreePath, ["add", "-A"]);
    git(worktreePath, ["commit", "-q", "-m", "edit"]);

    const patch = diffPatch(worktreePath, handle.baseSha);

    expect(patch).toContain("-line two");
    expect(patch).toContain("+line two changed");
  });

  it("returns an empty string when nothing changed since the base commit", () => {
    const handle = createWorktree({ repoPath, worktreePath, branch: "exec/test-attempt-1", baseRef: "HEAD" });
    expect(diffPatch(worktreePath, handle.baseSha)).toBe("");
  });

  it("truncates an oversized diff with a clear marker instead of returning it whole", () => {
    const handle = createWorktree({ repoPath, worktreePath, branch: "exec/test-attempt-1", baseRef: "HEAD" });
    writeFileSync(join(worktreePath, "big.txt"), "x".repeat(60_000));
    git(worktreePath, ["add", "-A"]);
    git(worktreePath, ["commit", "-q", "-m", "big file"]);

    const patch = diffPatch(worktreePath, handle.baseSha);

    expect(patch.length).toBeLessThan(60_000);
    expect(patch).toContain("[diff truncated");
  });
});
