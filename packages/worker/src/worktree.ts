import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

/**
 * One worker's isolated working copy.
 *
 * Every run gets its own git worktree rather than sharing the repo checkout — a
 * worker cannot step on another worker's uncommitted changes, and a killed run
 * leaves nothing behind that a later run could be confused by.
 */

export interface WorktreeHandle {
  repoPath: string;
  path: string;
  branch: string;
  /** The commit the attempt's branch started from, captured right after
   *  creation, before the worker can have touched anything. This is what
   *  lets an acceptance check tell "the worker committed and even pushed
   *  its own branch" apart from "nothing happened" — a plain working-tree
   *  dirty check can't, since a clean commit-and-push leaves nothing dirty. */
  baseSha: string;
}

function git(repoPath: string, args: string[]): string {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
  }).trim();
}

export interface CreateWorktreeArgs {
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
}

export function createWorktree(args: CreateWorktreeArgs): WorktreeHandle {
  mkdirSync(dirname(args.worktreePath), { recursive: true });
  // -B (re)creates the branch if it already exists, so a respawn under the same
  // branch name doesn't fail on a leftover from a killed attempt.
  git(args.repoPath, [
    "worktree",
    "add",
    "-B",
    args.branch,
    args.worktreePath,
    args.baseRef,
  ]);
  // Resolved from inside the new worktree, not the source repo: `baseRef` is
  // often the literal string "HEAD", which means something different in every
  // worktree that evaluates it. At this exact moment — right after creation,
  // before the worker's first tool call — the new worktree's HEAD *is* the
  // base commit, so this is the one point where reading it here gives the
  // real answer.
  const baseSha = git(args.worktreePath, ["rev-parse", "HEAD"]);
  return { repoPath: args.repoPath, path: args.worktreePath, branch: args.branch, baseSha };
}

/**
 * Block the calling thread without spinning — the clean way to retry a
 * filesystem operation after a short pause without pulling in async/await
 * everywhere else in this deliberately synchronous module.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const CLEANUP_RETRY_DELAYS_MS = [200, 500, 1000];

/** Retry a synchronous operation with short backoff. Never throws — returns
 *  whether it eventually succeeded. */
function retrySync(fn: () => void): boolean {
  for (let attempt = 0; attempt <= CLEANUP_RETRY_DELAYS_MS.length; attempt++) {
    try {
      fn();
      return true;
    } catch {
      if (attempt === CLEANUP_RETRY_DELAYS_MS.length) return false;
      sleepSync(CLEANUP_RETRY_DELAYS_MS[attempt]!);
    }
  }
  return false;
}

/**
 * Remove a worktree. Never throws — a cleanup failure must never crash the
 * rest of the run, only leave a directory behind for manual cleanup.
 *
 * `git worktree remove` can fail on Windows even after it has already deleted
 * almost everything: antivirus or the search indexer can transiently lock a
 * directory right after a batch of file deletes inside it, so git's own final
 * rmdir step fails and it reports the whole command as failed. A short retry
 * lets that lock clear before falling back to a plain recursive delete (also
 * retried the same way) — which keeps git's own worktree bookkeeping intact in
 * the common case instead of always reaching for the blunt fallback.
 */
export function removeWorktree(handle: WorktreeHandle): void {
  const gitRemoved = retrySync(() =>
    git(handle.repoPath, ["worktree", "remove", handle.path, "--force"]),
  );
  if (gitRemoved) return;

  const plainRemoved = retrySync(() =>
    rmSync(handle.path, { recursive: true, force: true }),
  );
  if (!plainRemoved) {
    console.warn(
      `warning: could not remove worktree at ${handle.path}. ` +
        `Left in place — safe to delete by hand once nothing has it open.`,
    );
  }

  try {
    git(handle.repoPath, ["worktree", "prune"]);
  } catch {
    /* best effort — worktree bookkeeping cleanup is not worth failing over */
  }
}

export interface ChurnStat {
  linesChanged: number;
  filesChanged: string[];
}

/**
 * Diff churn since the worktree's base commit — tracked changes plus untracked
 * new files. This is the raw signal the stall detector and the checkpoint both
 * read; it says nothing about whether the change is good, only whether the
 * working tree is moving.
 */
export function churn(worktreePath: string): ChurnStat {
  const filesChanged: string[] = [];
  let linesChanged = 0;

  try {
    const numstat = git(worktreePath, ["diff", "--numstat", "HEAD"]);
    for (const line of numstat.split("\n").filter(Boolean)) {
      const parts = line.split("\t");
      const add = parts[0];
      const del = parts[1];
      const file = parts[2];
      if (!file) continue;
      filesChanged.push(file);
      const a = Number(add);
      const d = Number(del);
      if (!Number.isNaN(a)) linesChanged += a;
      if (!Number.isNaN(d)) linesChanged += d;
    }
  } catch {
    /* not fatal to telemetry — treat as no churn this sample */
  }

  try {
    const status = git(worktreePath, ["status", "--porcelain"]);
    for (const line of status.split("\n").filter(Boolean)) {
      if (line.startsWith("??")) {
        const file = line.slice(3).trim();
        if (!filesChanged.includes(file)) {
          filesChanged.push(file);
          linesChanged += 1;
        }
      }
    }
  } catch {
    /* not fatal */
  }

  return { linesChanged, filesChanged };
}

/** Commit everything in the worktree. Returns false when there was nothing to commit. */
export function commitAll(worktreePath: string, message: string): boolean {
  git(worktreePath, ["add", "-A"]);
  try {
    git(worktreePath, ["commit", "-m", message]);
    return true;
  } catch {
    return false;
  }
}
