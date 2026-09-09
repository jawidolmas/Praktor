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

export interface MergeResult {
  merged: boolean;
  pushed: boolean;
  baseBranch: string;
  message: string;
}

/**
 * Merge the accepted branch into the real repo's base branch, then best-effort
 * push it. Refuses outright — no merge attempted at all — if the repo has
 * uncommitted changes, or if the base ref can't be resolved to a real branch
 * (detached HEAD): this is a write to state that isn't ours, so the failure
 * mode on anything ambiguous is "do nothing and say why," not "guess."
 */
export function mergeAndPush(target: ApprovalTarget): MergeResult {
  const baseBranch = resolveBaseBranch(target.repoPath, target.baseRef);
  if (baseBranch === "HEAD") {
    return {
      merged: false,
      pushed: false,
      baseBranch,
      message: "Repo is in a detached HEAD state — no named branch to merge into. Check out a branch first.",
    };
  }
  if (!isRepoClean(target.repoPath)) {
    return {
      merged: false,
      pushed: false,
      baseBranch,
      message: `${target.repoPath} has uncommitted changes — commit or stash them before approving, so this can't clobber work in progress.`,
    };
  }

  try {
    git(target.repoPath, ["checkout", baseBranch]);
    git(target.repoPath, ["merge", "--no-ff", target.branch, "-m", `Merge ${target.branch} (approved via exec-agent)`]);
  } catch (err) {
    return {
      merged: false,
      pushed: false,
      baseBranch,
      message: `Merge failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    git(target.repoPath, ["push", "origin", baseBranch]);
    return { merged: true, pushed: true, baseBranch, message: `Merged and pushed ${target.branch} into ${baseBranch}.` };
  } catch (err) {
    // The merge already succeeded locally and is not rolled back — a failed
    // push (no remote, or the same "no direct push to a protected branch"
    // rule a worker would hit) is not a reason to undo real, reviewed work.
    return {
      merged: true,
      pushed: false,
      baseBranch,
      message: `Merged ${target.branch} into ${baseBranch} locally, but push failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
