import { git } from "./worktree.js";

/**
 * The human review checkpoint. Everything upstream of this file operates on
 * an isolated worktree; this is the one place that touches the real repo the
 * objective named — on purpose, only once a person has looked at the diff
 * and said yes, never automatically from inside a worker's own run.
 */

export interface ApprovalTarget {
  repoPath: string;
  /** As stored on the objective. Often the literal string "HEAD" — resolved
   *  to a real branch name here, at approval time, rather than frozen at
   *  submission time, so it reflects whatever's actually checked out now. */
  baseRef: string;
  branch: string;
}

/** "HEAD" means a different thing depending on when and where you ask it —
 *  resolve it to the concrete branch name actually checked out right now,
 *  in the real repo, so a merge target is unambiguous. An explicit ref/branch
 *  (the user passed --base-ref) is trusted as-is. Detached HEAD has no named
 *  branch to resolve to; callers must treat "HEAD" back out as "can't merge." */
export function resolveBaseBranch(repoPath: string, baseRef: string): string {
  if (baseRef !== "HEAD") return baseRef;
  try {
    return git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    return "HEAD";
  }
}

export function isRepoClean(repoPath: string): boolean {
  try {
    return git(repoPath, ["status", "--porcelain"]).length === 0;
  } catch {
    return false;
  }
}

/** Diff of the accepted branch against its resolved base, for a human to
 *  actually read before approving anything. Three-dot (against the merge
 *  base) so unrelated commits landed on the base branch in the meantime
 *  don't show up as noise in what the worker changed. */
export function computeApprovalDiff(target: ApprovalTarget): string {
  const base = resolveBaseBranch(target.repoPath, target.baseRef);
  return git(target.repoPath, ["diff", `${base}...${target.branch}`]);
}

export interface BranchDiff {
  branch: string;
  diff: string;
}

/** One diff per accepted branch — an objective decomposed into several tasks
 *  has one accepted branch per task that reached "done", and a human
 *  reviewing it needs to see what each of them actually did, not one branch
 *  standing in for all of them. */
export function computeApprovalDiffs(
  target: { repoPath: string; baseRef: string },
  branches: string[],
): BranchDiff[] {
  return branches.map((branch) => ({
    branch,
    diff: computeApprovalDiff({ repoPath: target.repoPath, baseRef: target.baseRef, branch }),
  }));
}

export interface MergeResult {
  merged: boolean;
  pushed: boolean;
  baseBranch: string;
  message: string;
}

export interface BranchMergeResult {
  branch: string;
  merged: boolean;
  message: string;
}

export interface MultiMergeResult {
  baseBranch: string;
  branches: BranchMergeResult[];
  /** True only when every branch merged locally — a partial merge leaves the
   *  objective un-marked so a retry can pick up exactly where it left off. */
  allMerged: boolean;
  pushed: boolean;
  message: string;
}

/**
 * Merge every accepted branch into the real repo's base branch, in order,
 * then best-effort push once at the end. Refuses outright — no merge
 * attempted at all — if the repo has uncommitted changes, or if the base ref
 * can't be resolved to a real branch (detached HEAD): this is a write to
 * state that isn't ours, so the failure mode on anything ambiguous is "do
 * nothing and say why," not "guess."
 *
 * A conflict partway through stops the loop rather than pressing on: a later
 * task's branch may well have been written assuming an earlier one already
 * landed (e.g. "link CONTRIBUTING.md from README" assumes CONTRIBUTING.md
 * exists), so merging it into a repo already mid-conflict would only
 * compound the problem instead of surfacing one clean thing for a person to
 * resolve by hand. Whatever merged before the conflict stays merged — this
 * is a local, still-reviewable state, not something to roll back.
 */
export function mergeAndPushAll(target: { repoPath: string; baseRef: string }, branches: string[]): MultiMergeResult {
  const baseBranch = resolveBaseBranch(target.repoPath, target.baseRef);
  if (baseBranch === "HEAD") {
    const message = "Repo is in a detached HEAD state — no named branch to merge into. Check out a branch first.";
    return {
      baseBranch,
      branches: branches.map((branch) => ({ branch, merged: false, message })),
      allMerged: false,
      pushed: false,
      message,
    };
  }
  if (!isRepoClean(target.repoPath)) {
    const message = `${target.repoPath} has uncommitted changes — commit or stash them before approving, so this can't clobber work in progress.`;
    return {
      baseBranch,
      branches: branches.map((branch) => ({ branch, merged: false, message })),
      allMerged: false,
      pushed: false,
      message,
    };
  }

  try {
    git(target.repoPath, ["checkout", baseBranch]);
  } catch (err) {
    const message = `Could not check out ${baseBranch}: ${err instanceof Error ? err.message : String(err)}`;
    return {
      baseBranch,
      branches: branches.map((branch) => ({ branch, merged: false, message })),
      allMerged: false,
      pushed: false,
      message,
    };
  }

  const results: BranchMergeResult[] = [];
  for (const branch of branches) {
    try {
      git(target.repoPath, ["merge", "--no-ff", branch, "-m", `Merge ${branch} (approved via exec-agent)`]);
      results.push({ branch, merged: true, message: `Merged ${branch} into ${baseBranch}.` });
    } catch (err) {
      results.push({
        branch,
        merged: false,
        message: `Merge failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      for (const skipped of branches.slice(results.length)) {
        results.push({ branch: skipped, merged: false, message: "Skipped — an earlier branch failed to merge." });
      }
      break;
    }
  }

  const anyMerged = results.some((r) => r.merged);
  const allMerged = results.every((r) => r.merged);
  if (!anyMerged) {
    return { baseBranch, branches: results, allMerged, pushed: false, message: "Nothing merged." };
  }

  try {
    git(target.repoPath, ["push", "origin", baseBranch]);
    return {
      baseBranch,
      branches: results,
      allMerged,
      pushed: true,
      message: allMerged ? `Merged and pushed all ${results.length} branch(es) into ${baseBranch}.` : `Pushed ${baseBranch} with a partial merge — see branch results.`,
    };
  } catch (err) {
    // The merges that succeeded are not rolled back — a failed push (no
    // remote, or the same "no direct push to a protected branch" rule a
    // worker would hit) is not a reason to undo real, reviewed work.
    return {
      baseBranch,
      branches: results,
      allMerged,
      pushed: false,
      message: `Merged locally, but push failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
