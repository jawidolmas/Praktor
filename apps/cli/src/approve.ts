import { createInterface } from "node:readline/promises";
import { eq } from "drizzle-orm";
import {
  acceptedRun,
  appendEvent,
  markObjectiveMerged,
  objectives,
  openDb,
  runMigrations,
} from "@exec/db";
import { attemptBranchName, computeApprovalDiff, mergeAndPush } from "@exec/worker";

const MAX_DIFF_LINES = 400;

function printDiff(diff: string): void {
  const lines = diff.split("\n");
  const shown = lines.length > MAX_DIFF_LINES ? lines.slice(0, MAX_DIFF_LINES) : lines;
  console.log(shown.join("\n"));
  if (lines.length > MAX_DIFF_LINES) {
    console.log(`\n… ${lines.length - MAX_DIFF_LINES} more lines. Full diff: git diff <base>...<branch> in the repo.`);
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

/** Review a finished objective's diff and, if approved, merge it into the
 *  real repo's base branch and push. The one place in this system that
 *  writes to a repo the user actually works in, gated on an explicit human
 *  yes — never automatic, never from inside a worker's own run. */
export async function approveObjective(objectiveId: string): Promise<void> {
  const { db } = openDb();
  runMigrations(db);

  const objective = db.select().from(objectives).where(eq(objectives.id, objectiveId)).get();
  if (!objective) {
    console.error(`No such objective: ${objectiveId}`);
    process.exitCode = 1;
    return;
  }
  if (objective.mergedAt) {
    console.log(`Already approved and merged at ${new Date(objective.mergedAt).toLocaleString()}.`);
    return;
  }

  const accepted = acceptedRun(db, objectiveId);
  if (!accepted) {
    console.error(
      objective.status === "done"
        ? "Objective is done, but no accepted run was found — nothing to approve."
        : `Objective isn't done yet (status: ${objective.status}) — nothing to approve.`,
    );
    process.exitCode = 1;
    return;
  }

  const branch = attemptBranchName(accepted.taskId, accepted.attempt);
  const diff = computeApprovalDiff({ repoPath: accepted.repoPath, baseRef: accepted.baseRef, branch });

  if (!diff.trim()) {
    console.log("No diff to show — the accepted branch has nothing beyond its base. Nothing to approve.");
    return;
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log(`Reviewing ${branch}  (repo: ${accepted.repoPath})`);
  console.log("=".repeat(72));
  printDiff(diff);
  console.log("=".repeat(72));

  const approved = await confirm(`Merge ${branch} into your real repo and push?`);
  if (!approved) {
    console.log("Not merged.");
    return;
  }

  const result = mergeAndPush({ repoPath: accepted.repoPath, baseRef: accepted.baseRef, branch });
  console.log(result.message);

  if (result.merged) {
    markObjectiveMerged(db, objectiveId);
    appendEvent(db, {
      objectiveId,
      payload: {
        type: "objective.approved",
        branch,
        baseRef: result.baseBranch,
        pushed: result.pushed,
        approvedBy: "cli-operator",
      },
    });
  } else {
    process.exitCode = 1;
  }
}
