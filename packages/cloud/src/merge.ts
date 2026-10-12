import { homedir } from "node:os";
import { eq } from "drizzle-orm";
import {
  acceptedRuns,
  appendEvent,
  markObjectiveMerged,
  objectives,
  releaseApproveLock,
  tryAcquireApproveLock,
  type Db,
} from "@exec/db";
import { attemptBranchName, computeApprovalDiffs, mergeAndPushAll, type BranchDiff, type MultiMergeResult } from "@exec/worker";
import { repoName } from "./mapping.js";

/**
 * Carries out a merge requested from the phone. It runs the same steps, in
 * the same order, as the dashboard's Merge button and `exec-agent approve`:
 * accepted runs only, a non-empty diff, the shared approve lock (so it can
 * never race a merge started from the dashboard or CLI), then
 * mergeAndPushAll — which itself refuses a dirty repo or a detached HEAD.
 */

/** How phone approvals are attributed in the audit log. */
export const APP_APPROVED_BY = "app";

export interface PendingMerge {
  id: string;
  objective_id: string;
}

export interface MergeInbox {
  pending(): Promise<PendingMerge[]>;
  settle(id: string, status: "merged" | "failed", message: string, pushed: boolean | null): Promise<void>;
}

export interface MergeOutcome {
  status: "merged" | "failed";
  message: string;
  pushed: boolean | null;
}

/** The git half, injectable so every outcome can be tested without a repo. */
export interface MergeGit {
  diffs(target: { repoPath: string; baseRef: string }, branches: string[]): BranchDiff[];
  merge(target: { repoPath: string; baseRef: string }, branches: string[]): MultiMergeResult;
}

const realGit: MergeGit = { diffs: computeApprovalDiffs, merge: mergeAndPushAll };

/** git's messages name the repo by its full local path; the phone only ever
 *  sees the repo's folder name (sync level B: no local paths leave the PC). */
export function scrubPaths(text: string, repoPath: string): string {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const variants = new Set([repoPath, repoPath.replace(/\\/g, "/"), repoPath.replace(/\//g, "\\")]);
  let out = text;
  for (const v of variants) if (v) out = out.replace(new RegExp(escape(v), "gi"), repoName(repoPath));
  const home = homedir();
  for (const v of new Set([home, home.replace(/\\/g, "/")])) if (v) out = out.replace(new RegExp(escape(v), "gi"), "~");
  return out;
}

export function mergeForApp(db: Db, objectiveId: string, git: MergeGit = realGit): MergeOutcome {
  const objective = db.select().from(objectives).where(eq(objectives.id, objectiveId)).get();
  if (!objective) return { status: "failed", message: "This objective isn’t on that computer anymore.", pushed: null };
  // Already merged — possibly by this very request, if the PC stopped after
  // merging but before reporting back. Either way the outcome is "merged".
  if (objective.mergedAt) return { status: "merged", message: "Already merged.", pushed: null };

  const accepted = acceptedRuns(db, objectiveId);
  if (accepted.length === 0) {
    return {
      status: "failed",
      message: objective.status === "done" ? "There’s no accepted work to merge." : "It isn’t finished on your computer yet.",
      pushed: null,
    };
  }

  const target = { repoPath: accepted[0]!.repoPath, baseRef: accepted[0]!.baseRef };
  const branches = accepted.map((a) => attemptBranchName(a.taskId, a.attempt));
  const scrub = (text: string) => scrubPaths(text, target.repoPath);

  let diffs: BranchDiff[];
  try {
    diffs = git.diffs(target, branches);
  } catch (err) {
    return { status: "failed", message: scrub(`Couldn’t read the changes: ${err instanceof Error ? err.message : String(err)}`), pushed: null };
  }
  if (diffs.every((d) => !d.diff.trim())) {
    return { status: "failed", message: "Nothing to merge — the agents’ branches have no changes beyond the base.", pushed: null };
  }

  const lock = tryAcquireApproveLock(db, objectiveId, APP_APPROVED_BY);
  if (!lock.acquired) {
    return {
      status: "failed",
      message: `It’s already being merged elsewhere${lock.heldBy ? ` (${lock.heldBy})` : ""} — try again in a moment.`,
      pushed: null,
    };
  }

  try {
    const result = git.merge(target, branches);
    if (result.allMerged) {
      markObjectiveMerged(db, objectiveId);
      appendEvent(db, {
        objectiveId,
        payload: {
          type: "objective.approved",
          branch: branches.join(", "),
          baseRef: result.baseBranch,
          pushed: result.pushed,
          approvedBy: APP_APPROVED_BY,
        },
      });
      return { status: "merged", message: scrub(result.message), pushed: result.pushed };
    }
    // The first branch that failed says why (a conflict, a dirty repo…);
    // the overall message alone is often just "Nothing merged."
    const failed = result.branches.find((b) => !b.merged);
    return { status: "failed", message: scrub(failed?.message ?? result.message), pushed: result.pushed };
  } catch (err) {
    return { status: "failed", message: scrub(`The merge stopped: ${err instanceof Error ? err.message : String(err)}`), pushed: null };
  } finally {
    releaseApproveLock(db, objectiveId);
  }
}

/** Runs every pending merge; returns how many succeeded. */
export async function processMerges(db: Db, inbox: MergeInbox, git: MergeGit = realGit): Promise<number> {
  let merged = 0;
  for (const m of await inbox.pending()) {
    const outcome = mergeForApp(db, m.objective_id, git);
    await inbox.settle(m.id, outcome.status, outcome.message, outcome.pushed);
    if (outcome.status === "merged") merged += 1;
  }
  return merged;
}
