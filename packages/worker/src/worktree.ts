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
  return { repoPath: args.repoPath, path: args.worktreePath, branch: args.branch };
}

export function removeWorktree(handle: WorktreeHandle): void {
  try {
    git(handle.repoPath, ["worktree", "remove", handle.path, "--force"]);
  } catch {
    // The worktree may already be gone or locked; fall back to a plain delete so
    // cleanup never blocks the rest of the run on a git-level disagreement.
    rmSync(handle.path, { recursive: true, force: true });
    try {
      git(handle.repoPath, ["worktree", "prune"]);
    } catch {
      /* best effort */
    }
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
