import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * check-repo-changed.mjs is a standalone script (an acceptance-check shell
 * command), so it's tested as it's actually invoked: as a child process
 * against a real git repo, not by importing its internals.
 */

const scriptPath = join(import.meta.dirname, "check-repo-changed.mjs");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function run(cwd: string, baseSha?: string) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...(baseSha ? { EXEC_BASE_SHA: baseSha } : { EXEC_BASE_SHA: "" }) },
  });
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "check-repo-changed-test-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "hello");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("check-repo-changed.mjs", () => {
  it("exits 1 when nothing changed and no base sha is given", () => {
    expect(run(dir).status).toBe(1);
  });

  it("exits 0 for an uncommitted (dirty) change, base sha or not", () => {
    writeFileSync(join(dir, "NEW.md"), "content");
    expect(run(dir).status).toBe(0);
  });

  it("exits 1 for a clean tree still at the base commit — the true nothing-happened case", () => {
    const baseSha = git(dir, ["rev-parse", "HEAD"]);
    expect(run(dir, baseSha).status).toBe(1);
  });

  it("exits 0 when the worker committed past the base sha, even though the tree is clean", () => {
    // The exact case this script exists for: a worker that committed (and,
    // in the real scenario, pushed) its own change, leaving nothing dirty —
    // the bug being fixed is that a dirty-only check reads this as failure.
    const baseSha = git(dir, ["rev-parse", "HEAD"]);
    writeFileSync(join(dir, "COMMITTED.md"), "content");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "worker's own commit"]);

    expect(run(dir, baseSha).status).toBe(0);
  });
});
