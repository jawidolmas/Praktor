import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { git, removeWorktree } from "./worktree.js";

/**
 * Cross-task integration.
 *
 * Every task gets its own isolated worktree, always checked out fresh from
 * the objective's original base ref — that isolation is what keeps a failed
 * or retried task from ever stepping on another one's uncommitted state. The
 * cost, confirmed live: a task that depends on another literally cannot see
 * what its dependency produced, because its worktree was never told about
 * it. "Link CONTRIBUTING.md and SECURITY.md from README" started in a
 * worktree where neither file existed, even though the tasks that create
 * them had already finished — dependency order controlled *when* it ran,
 * not what it could see.
 *
 * The fix: an integration branch per objective, folding in each task's
 * accepted branch the moment it's done. A task with dependencies checks out
 * its worktree from that branch instead of the raw base ref, so it inherits
 * every completed dependency's actual files — not a description of them.
 * The fold itself runs through a short-lived scratch worktree that exists
 * only for the duration of one merge and is always removed afterward; the
 * branch ref is the only thing that persists between folds, exactly like
 * any other git branch nobody has checked out.
 */

export function integrationBranchName(objectiveId: string): string {
  return `exec/${objectiveId.slice(0, 8)}-integration`;
}

export function integrationScratchDirName(objectiveId: string): string {
  return `${objectiveId}-integration-scratch`;
}

export function integrationBranchExists(repoPath: string, objectiveId: string): boolean {
  try {
    git(repoPath, ["rev-parse", "--verify", "--quiet", integrationBranchName(objectiveId)]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Which ref a task's worktree should actually be checked out from. A task
 * with no dependencies is unaffected by any of this — it always starts from
 * the objective's own base ref, exactly as before, so two genuinely
 * independent tasks never get coupled to each other by accident. A task
 * with dependencies uses the integration branch once one exists; by the
 * time a dependent task is schedulable at all (see `readyTasks`), every
 * task it depends on is already "done," so the branch reflects everything
 * it's allowed to assume is there — modulo a fold conflict, see below.
 */
export function resolveTaskBaseRef(args: {
  repoPath: string;
  objectiveId: string;
  objectiveBaseRef: string;
  dependsOn: string[];
}): string {
  if (args.dependsOn.length === 0) return args.objectiveBaseRef;
  return integrationBranchExists(args.repoPath, args.objectiveId)
    ? integrationBranchName(args.objectiveId)
    : args.objectiveBaseRef;
}

export interface FoldResult {
  ok: boolean;
  message: string;
}

/**
 * Fold one just-completed task's accepted branch into the objective's
 * integration branch. Best-effort by design: a conflict here means two
 * sibling tasks touched the same file in genuinely incompatible ways — a
 * real planning/content problem, not something to paper over automatically.
 * The task that just finished is not affected either way (its own work is
 * already committed on its own branch, untouched); only a *future* dependent
 * task loses the benefit of seeing this one's files, and falls back to
 * exactly today's behavior for that file — ask, the same live-verified path
 * that already handles this gracefully.
 */
export function foldIntoIntegrationBranch(args: {
  repoPath: string;
  objectiveId: string;
  objectiveBaseRef: string;
  taskBranch: string;
  worktreesDir: string;
}): FoldResult {
  const branch = integrationBranchName(args.objectiveId);
  const existed = integrationBranchExists(args.repoPath, args.objectiveId);
  const scratchPath = join(args.worktreesDir, integrationScratchDirName(args.objectiveId));

  mkdirSync(args.worktreesDir, { recursive: true });
  try {
    if (existed) {
      // No -B here, deliberately: unlike an attempt worktree (always reset
      // to a clean starting point), this branch's whole purpose is to keep
      // what earlier folds already added.
      git(args.repoPath, ["worktree", "add", scratchPath, branch]);
    } else {
      git(args.repoPath, ["worktree", "add", "-b", branch, scratchPath, args.objectiveBaseRef]);
    }
  } catch (err) {
    return { ok: false, message: `Could not check out the integration branch: ${err instanceof Error ? err.message : String(err)}` };
  }

  try {
    git(scratchPath, ["-c", "core.autocrlf=false", "merge", "--no-ff", args.taskBranch, "-m", `Integrate ${args.taskBranch}`]);
    return { ok: true, message: `Folded ${args.taskBranch} into ${branch}.` };
  } catch (err) {
    try {
      git(scratchPath, ["merge", "--abort"]);
    } catch {
      /* best effort */
    }
    return {
      ok: false,
      message: `${args.taskBranch} conflicts with what's already integrated — a dependent task will start without its changes and may need to ask: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    removeWorktree({ repoPath: args.repoPath, path: scratchPath, branch, baseSha: "" });
  }
}
