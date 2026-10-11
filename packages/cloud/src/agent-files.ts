import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { objectives, runs, tasks, type Db } from "@exec/db";
import { attemptBranchName, resolveBaseBranch } from "@exec/worker";

/**
 * What each task's worker actually touched, as paths only — the "agent tree"
 * the app draws. Read from git objects (`git diff --name-status`) against the
 * real repo, never from a worktree directory, and never with file contents:
 * that's the line between sync level B and level C.
 */

/** Per task. Plenty for any real change set, small enough that a runaway
 *  task (a vendored dependency, a generated tree) can't flood the relay. */
export const MAX_CHANGES_PER_TASK = 2000;

export interface FileChange {
  /** git's status letter: A(dded), M(odified), D(eleted), R(enamed), … */
  status: string;
  path: string;
  oldPath?: string;
}

export interface TaskFiles {
  taskId: string;
  attempt: number;
  branch: string;
  available: boolean;
  changes: FileChange[];
  truncated: boolean;
}

/** Read-only git against the real repo. Arguments are always an array (no
 *  shell), every ref comes from the database rather than from any client,
 *  and the buffer is raised above Node's 1MB default. */
function gitRead(repoPath: string, args: string[]): string {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** Parses `git diff --name-status -z`: NUL-separated, with renames and
 *  copies carrying two paths (old, then new). */
export function parseNameStatusZ(output: string): FileChange[] {
  const parts = output.split("\0").filter((p) => p.length > 0);
  const changes: FileChange[] = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++]!.charAt(0);
    if (status === "R" || status === "C") {
      const oldPath = parts[i++];
      const path = parts[i++];
      if (oldPath !== undefined && path !== undefined) changes.push({ status, path, oldPath });
    } else {
      const path = parts[i++];
      if (path !== undefined) changes.push({ status, path });
    }
  }
  return changes;
}

/** For each task that has started at least one attempt, the paths its most
 *  recent attempt changed against the objective's base. A branch that's
 *  gone (merged and cleaned up) comes back `available: false`, so the caller
 *  can keep whatever it last recorded instead of wiping it. */
export function agentFilesFor(db: Db, objectiveId: string): TaskFiles[] {
  const objective = db.select().from(objectives).where(eq(objectives.id, objectiveId)).get();
  if (!objective) return [];

  const latestAttempt = new Map<string, number>();
  for (const run of db.select().from(runs).where(eq(runs.objectiveId, objectiveId)).all()) {
    latestAttempt.set(run.taskId, Math.max(latestAttempt.get(run.taskId) ?? 0, run.attempt));
  }
  if (latestAttempt.size === 0) return [];

  const base = resolveBaseBranch(objective.repoPath, objective.baseRef);
  // A ref starting with "-" would be parsed by git as an option.
  const baseIsSafe = !base.startsWith("-");

  return db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.objectiveId, objectiveId))
    .all()
    .filter((t) => latestAttempt.has(t.id))
    .map((t) => {
      const attempt = latestAttempt.get(t.id)!;
      const branch = attemptBranchName(t.id, attempt);
      const missing = { taskId: t.id, attempt, branch, available: false, changes: [], truncated: false };
      if (!baseIsSafe) return missing;
      try {
        gitRead(objective.repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
        const all = parseNameStatusZ(gitRead(objective.repoPath, ["diff", "--name-status", "-z", `${base}...${branch}`]));
        return {
          ...missing,
          available: true,
          changes: all.slice(0, MAX_CHANGES_PER_TASK),
          truncated: all.length > MAX_CHANGES_PER_TASK,
        };
      } catch {
        return missing;
      }
    });
}
