import { createInterface } from "node:readline/promises";
import { eq } from "drizzle-orm";
import {
  acceptedRuns,
  appendEvent,
  markObjectiveMerged,
  objectives,
  openDb,
  releaseApproveLock,
  runMigrations,
  tasks,
  tryAcquireApproveLock,
} from "@exec/db";
import { attemptBranchName, computeApprovalDiffs, mergeAndPushAll } from "@exec/worker";

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

  const accepted = acceptedRuns(db, objectiveId);
  if (accepted.length === 0) {
    console.error(
      objective.status === "done"
        ? "Objective is done, but no accepted run was found — nothing to approve."
        : `Objective isn't done yet (status: ${objective.status}) — nothing to approve.`,
    );
    process.exitCode = 1;
    return;
  }

  const taskById = new Map(
    db.select().from(tasks).where(eq(tasks.objectiveId, objectiveId)).all().map((t) => [t.id, t] as const),
  );
  const branches = accepted.map((a) => attemptBranchName(a.taskId, a.attempt));
  const diffs = computeApprovalDiffs({ repoPath: accepted[0]!.repoPath, baseRef: accepted[0]!.baseRef }, branches);

  const nonEmpty = diffs.filter((d) => d.diff.trim());
  if (nonEmpty.length === 0) {
    console.log("No diff to show — every accepted branch has nothing beyond its base. Nothing to approve.");
    return;
  }

  console.log(`\n${"=".repeat(72)}`);
  for (const [i, d] of diffs.entries()) {
    const task = taskById.get(accepted[i]!.taskId);
    console.log(`Reviewing ${d.branch}  —  ${task?.title ?? "(task)"}  (repo: ${accepted[0]!.repoPath})`);
    console.log("-".repeat(72));
    printDiff(d.diff.trim() ? d.diff : "(no diff beyond base)");
    console.log("=".repeat(72));
  }

  const approved = await confirm(
    `Merge ${branches.length} branch(es) into your real repo and push?`,
  );
  if (!approved) {
    console.log("Not merged.");
    return;
  }

  // Confirmed live: running this from the CLI while the dashboard's Merge
  // button was also clicked on the same objective raced two independent
  // git checkout/merge sequences against the same repo directory. The lock
  // makes "someone else is already approving this" an explicit, clear
  // outcome instead of an accidental interleaving.
  const lock = tryAcquireApproveLock(db, objectiveId, "cli-operator");
  if (!lock.acquired) {
    console.error(
      `This objective is already being approved elsewhere (by ${lock.heldBy ?? "another session"}) — try again shortly.`,
    );
    process.exitCode = 1;
    return;
  }

  try {
    const result = mergeAndPushAll({ repoPath: accepted[0]!.repoPath, baseRef: accepted[0]!.baseRef }, branches);
    for (const b of result.branches) console.log(`  [${b.merged ? "OK" : "FAIL"}] ${b.branch} — ${b.message}`);
    console.log(result.message);

    if (result.allMerged) {
      markObjectiveMerged(db, objectiveId);
      appendEvent(db, {
        objectiveId,
        payload: {
          type: "objective.approved",
          branch: branches.join(", "),
          baseRef: result.baseBranch,
          pushed: result.pushed,
          approvedBy: "cli-operator",
        },
      });
    } else {
      process.exitCode = 1;
    }
  } finally {
    releaseApproveLock(db, objectiveId);
  }
}
