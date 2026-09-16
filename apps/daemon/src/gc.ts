import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { objectives, tasks, type Db } from "@exec/db";
import { attemptBranchName, integrationBranchName, removeWorktree } from "@exec/worker";

const INTEGRATION_SCRATCH_SUFFIX = "-integration-scratch";

/**
 * Worktree reclamation — the other half of what `driveTask`'s own cleanup
 * doesn't cover.
 *
 * `driveTask` already removes a worktree the instant an attempt fails and it
 * checkpoints into a respawn (engine.ts), so a task that keeps retrying never
 * accumulates disk. What nothing ever revisits is a task's *last* worktree
 * once driving stops for good: a successful attempt's worktree has to
 * survive until a human reviews and merges it (`approve` diffs and merges
 * straight from it — see packages/worker/src/approve.ts), and a permanently
 * failed task's in-flight worktree, if the daemon happened to crash mid
 * attempt, is never touched by the normal retry loop at all (that loop never
 * runs again for a task that resolves through an L3 decision instead). Both
 * are exactly the kind of disk a "walk away for weeks" system leaks forever
 * if nothing ever sweeps it.
 */

interface ParsedWorktreeDir {
  taskId: string;
  attempt: number;
}

/** Reverse of `worktreePathFor`'s `${taskId}-${attempt}` naming. `taskId` is
 *  itself a UUID full of hyphens, so only the last hyphen-separated segment
 *  can be the attempt number. */
export function parseWorktreeDirName(name: string): ParsedWorktreeDir | undefined {
  const idx = name.lastIndexOf("-");
  if (idx === -1) return undefined;
  const attempt = Number(name.slice(idx + 1));
  if (!Number.isInteger(attempt) || attempt <= 0) return undefined;
  const taskId = name.slice(0, idx);
  if (!taskId) return undefined;
  return { taskId, attempt };
}

export interface ReclaimContext {
  taskStatus: string;
  /** The task's own `attempts` counter — attempts strictly below this are
   *  superseded by a later, concluded attempt and can never matter again. */
  taskCurrentAttempts: number;
  objectiveStatus: string;
  objectiveMergedAt: number | null;
  /** Which attempt this specific worktree directory belongs to. */
  attempt: number;
}

/**
 * Pure decision: does this one worktree directory still have a reason to
 * exist? Deliberately conservative — anything not confidently covered by one
 * of these rules is left alone. A worktree surviving too long only costs
 * disk; removing one still needed would be unrecoverable.
 */
export function shouldReclaimWorktree(ctx: ReclaimContext): boolean {
  // A strictly older attempt than the task's current one is always stale —
  // driveTask has already moved past it.
  if (ctx.attempt < ctx.taskCurrentAttempts) return true;

  // Nothing ever reads a failed or abandoned task's worktree — `approve`
  // only ever looks at "done" tasks (see acceptedRuns) — regardless of what
  // the rest of the objective goes on to do. This is what actually covers a
  // task whose last attempt was in flight when the daemon crashed and later
  // resolved "failed" through an L3 decision instead of through the normal
  // retry loop, which is the one path that never calls removeWorktree itself.
  if (ctx.taskStatus === "failed" || ctx.taskStatus === "abandoned") return true;

  // An objective that will never be merged has nothing left to keep any of
  // its tasks' worktrees around for.
  if (ctx.objectiveStatus === "failed" || ctx.objectiveStatus === "cancelled") return true;

  // A merged objective's worktrees have already been captured into the real
  // repo by the merge commit itself.
  if (ctx.objectiveStatus === "done" && ctx.objectiveMergedAt !== null) return true;

  // Anything else — still running, blocked, parked, or "done" but not yet
  // reviewed — might still be needed.
  return false;
}

export interface ReclaimResult {
  removed: number;
  kept: number;
}

/** Sweep every worktree directory on disk and remove the ones nothing will
 *  ever need again. Safe to call at any time, on any schedule — a directory
 *  it can't confidently place (unknown naming, missing task/objective row)
 *  is left alone rather than guessed about. */
export function reclaimWorktrees(db: Db, worktreesDir: string): ReclaimResult {
  let entries: string[];
  try {
    entries = readdirSync(worktreesDir);
  } catch {
    return { removed: 0, kept: 0 };
  }

  let removed = 0;
  let kept = 0;

  for (const name of entries) {
    const path = join(worktreesDir, name);
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }

    // An integration-branch scratch worktree only ever exists for the
    // duration of one fold (foldIntoIntegrationBranch removes it itself,
    // success or failure) — seeing one here at all means a crash happened
    // mid-fold. Whatever it holds is either already captured in the
    // integration branch ref or was never going to be, so it's always safe
    // to remove outright, independent of the owning objective's status.
    if (name.endsWith(INTEGRATION_SCRATCH_SUFFIX)) {
      const objectiveId = name.slice(0, -INTEGRATION_SCRATCH_SUFFIX.length);
      const objective = db.select().from(objectives).where(eq(objectives.id, objectiveId)).get();
      removeWorktree({
        repoPath: objective?.repoPath ?? path,
        path,
        branch: objective ? integrationBranchName(objective.id) : "",
        baseSha: "",
      });
      removed++;
      continue;
    }

    const parsed = parseWorktreeDirName(name);
    if (!parsed) continue;

    const task = db.select().from(tasks).where(eq(tasks.id, parsed.taskId)).get();
    const objective = task ? db.select().from(objectives).where(eq(objectives.id, task.objectiveId)).get() : undefined;

    // No task or objective row at all — this worktree is not referenced by
    // anything left in the database and can only be leftover cruft.
    const reclaim =
      !task || !objective
        ? true
        : shouldReclaimWorktree({
            taskStatus: task.status,
            taskCurrentAttempts: task.attempts,
            objectiveStatus: objective.status,
            objectiveMergedAt: objective.mergedAt,
            attempt: parsed.attempt,
          });

    if (!reclaim) {
      kept++;
      continue;
    }

    removeWorktree({
      repoPath: objective?.repoPath ?? path,
      path,
      branch: attemptBranchName(parsed.taskId, parsed.attempt),
      baseSha: "",
    });
    removed++;
  }

  return { removed, kept };
}
