import { and, desc, eq, isNull } from "drizzle-orm";
import {
  answerDecision,
  artifacts,
  decisions,
  objectives,
  openDb,
  readEvents,
  runMigrations,
  type Db,
} from "@exec/db";
import { reconcileSeedPolicies } from "@exec/policy";
import { formatLiveLine } from "@exec/worker";
import { askInTerminal } from "./decide.js";
import { ensureDaemonRunning } from "./daemon-client.js";

import { submitDraftObjective, submitObjective, type DraftObjectiveArgs, type RunObjectiveArgs } from "@exec/db";

export { submitDraftObjective, submitObjective, type DraftObjectiveArgs, type RunObjectiveArgs };

const TERMINAL_STATUSES = new Set(["done", "failed", "cancelled"]);
const POLL_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Answer a decision right here in the terminal if it's still open — the
 * same prompt this system has always shown, just no longer the only way to
 * answer one. If you've walked away, `exec-agent decide` or the dashboard
 * gets there first, and this politely backs off (`answerDecision` refuses a
 * second answer) rather than making you choose something already decided.
 */
async function handleDecisionPrompt(db: Db, key: string): Promise<void> {
  const row = db.select().from(decisions).where(eq(decisions.key, key)).get();
  if (!row || row.status !== "open") return;

  const answered = await askInTerminal({
    title: row.title,
    context: row.context,
    options: row.options,
    recommendation: row.recommendation,
    risk: row.risk as "low" | "medium" | "high",
  });
  const applied = answerDecision(db, {
    key,
    answer: answered.answer,
    answeredBy: answered.answeredBy,
  });
  if (!applied) {
    console.log(`(${key} was already answered elsewhere while you were choosing — your answer was not applied.)`);
  }
}

function printFinalReport(db: Db, objectiveId: string): void {
  // taskId IS NULL is what picks out the one objective-level summary (written
  // by setObjectiveStatus in @exec/db) from among the many per-task reports
  // sharing the same "report" kind. Without this, a multi-task objective
  // would show whichever task's own report happened to be written last —
  // confirmed live: that left a 9-task run's final print showing only one
  // failed task's story, with no indication several others had actually
  // finished with real, committed work on their own branches.
  const report = db
    .select()
    .from(artifacts)
    .where(
      and(eq(artifacts.objectiveId, objectiveId), eq(artifacts.kind, "report"), isNull(artifacts.taskId)),
    )
    .orderBy(desc(artifacts.createdAt))
    .limit(1)
    .get();
  if (report && typeof report.content === "string") {
    console.log(report.content);
  } else {
    console.log(`\nObjective ${objectiveId} finished, but no report artifact was found for it.`);
  }
  console.log(`Objective id: ${objectiveId}`);
  console.log(`Full event log: exec-agent events ${objectiveId}`);
}

/**
 * Follow an objective's event log live, printing exactly what the old
 * synchronous CLI used to print — the only difference is that the daemon,
 * not this process, is the one doing the work. Ctrl-C here stops watching,
 * not the objective: it keeps running in the daemon regardless.
 */
export async function tailObjective(db: Db, objectiveId: string): Promise<void> {
  let sinceId = 0;
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
  };
  process.once("SIGINT", onSigint);

  try {
    for (;;) {
      const events = readEvents(db, { objectiveId, since: sinceId, limit: 2000 });
      for (const row of events) {
        sinceId = Math.max(sinceId, row.id);
        const line = formatLiveLine(row.payload);
        if (line) console.log(line);
        if (row.payload.type === "decision.raised") {
          await handleDecisionPrompt(db, row.payload.key);
        }
      }

      const objective = db.select().from(objectives).where(eq(objectives.id, objectiveId)).get();
      if (objective && TERMINAL_STATUSES.has(objective.status)) {
        printFinalReport(db, objectiveId);
        return;
      }

      if (interrupted) {
        console.log(
          `\nStill running in the background daemon — nothing was stopped.\nReattach any time with: exec-agent watch ${objectiveId}`,
        );
        return;
      }

      await sleep(POLL_MS);
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}

export type SubmitAndWatchArgs =
  | ({ mode: "direct" } & RunObjectiveArgs)
  | ({ mode: "plan" } & DraftObjectiveArgs);

/** The full "do"/"run" flow: submit, make sure a daemon is there to pick it
 *  up, then watch it happen. "direct" is today's one-task path; "plan" is a
 *  sentence too open-ended for `inferCheck` to pin a check to, handed to the
 *  daemon's planner instead of guessing. */
export async function submitAndWatch(args: SubmitAndWatchArgs): Promise<void> {
  const { db } = openDb();
  runMigrations(db);
  reconcileSeedPolicies(db);

  const { objectiveId } =
    args.mode === "direct" ? submitObjective(db, args) : submitDraftObjective(db, args);
  console.log(`Objective submitted: ${objectiveId}`);
  if (args.mode === "plan") {
    console.log("Breaking this down into a task graph before starting — this can take a moment.");
  }

  const daemon = await ensureDaemonRunning();
  console.log(
    daemon.started
      ? `Started the supervisor daemon (pid ${daemon.pid}).`
      : `Supervisor daemon already running (pid ${daemon.pid}).`,
  );

  await tailObjective(db, objectiveId);
}
