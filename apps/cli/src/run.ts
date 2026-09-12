import { and, desc, eq } from "drizzle-orm";
import {
  newId,
  taskKey,
  type AcceptanceCheck,
  type AcceptanceSpec,
  type Budget,
  type EffortLevel,
  type ObjectiveOnFailure,
} from "@exec/core";
import {
  answerDecision,
  appendEvent,
  artifacts,
  decisions,
  objectives,
  openDb,
  readEvents,
  runMigrations,
  tasks,
  type Db,
} from "@exec/db";
import { reconcileSeedPolicies } from "@exec/policy";
import { formatLiveLine } from "@exec/worker";
import { askInTerminal } from "./decide.js";
import { ensureDaemonRunning } from "./daemon-client.js";

export interface RunObjectiveArgs {
  repoPath: string;
  baseRef: string;
  title: string;
  intent: string;
  checks: AcceptanceCheck[];
  model: string;
  effort: EffortLevel;
  maxAttempts: number;
  maxTurns: number;
  maxWallClockMs: number;
  onFailure: ObjectiveOnFailure;
}

/** The same shape, minus the one field only the direct (non-planned) path
 *  has: a draft objective is submitted with no checks and no task at all —
 *  the daemon's planner decides how many tasks it needs and what proves
 *  each one done. */
export type DraftObjectiveArgs = Omit<RunObjectiveArgs, "checks">;

function objectiveBudget(args: { maxTurns: number; maxWallClockMs: number }): Budget {
  return { maxTurns: args.maxTurns, maxTokens: 400_000, maxWallClockMs: args.maxWallClockMs };
}

/**
 * Insert an objective and its (currently: one) task, immediately schedulable
 * by the daemon. This is deliberately all this does — no worktree, no
 * worker, no waiting. The daemon reconstructs everything it needs to run the
 * task from these two rows alone, which is what lets it survive this CLI
 * process exiting a moment later.
 */
export function submitObjective(
  db: Db,
  args: RunObjectiveArgs,
): { objectiveId: string; taskId: string } {
  const objectiveId = newId();
  const now = Date.now();
  const budget = objectiveBudget(args);

  db.insert(objectives)
    .values({
      id: objectiveId,
      title: args.title,
      brief: args.intent,
      repoPath: args.repoPath,
      baseRef: args.baseRef,
      status: "active",
      budget,
      onFailure: args.onFailure,
      model: args.model,
      effort: args.effort,
      maxAttempts: args.maxAttempts,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  appendEvent(db, {
    objectiveId,
    payload: { type: "objective.created", title: args.title, repoPath: args.repoPath },
  });

  const taskId = newId();
  const key = taskKey(1);
  const acceptance: AcceptanceSpec = { checks: args.checks };

  db.insert(tasks)
    .values({
      id: taskId,
      objectiveId,
      key,
      title: args.title,
      intent: args.intent,
      taskClass: "implement",
      acceptance,
      dependsOn: [],
      status: "ready",
      attempts: 0,
      maxAttempts: args.maxAttempts,
      budget,
      model: args.model,
      effort: args.effort,
      ruledOut: [],
      createdAt: now,
      updatedAt: now,
    })
    .run();
  appendEvent(db, {
    objectiveId,
    taskId,
    payload: { type: "task.created", key, title: args.title, dependsOn: [] },
  });

  return { objectiveId, taskId };
}

/**
 * Insert an objective with no tasks yet, status "draft" — the daemon's
 * planner (apps/daemon/src/plan.ts) is what turns it into a real task graph,
 * asynchronously, the next time its main loop ticks. Submitting is still
 * instant and synchronous from the CLI's point of view; only the planning
 * itself happens later, in the daemon, so closing this terminal right after
 * submitting cannot lose it.
 */
export function submitDraftObjective(
  db: Db,
  args: DraftObjectiveArgs,
): { objectiveId: string } {
  const objectiveId = newId();
  const now = Date.now();

  db.insert(objectives)
    .values({
      id: objectiveId,
      title: args.title,
      brief: args.intent,
      repoPath: args.repoPath,
      baseRef: args.baseRef,
      status: "draft",
      budget: objectiveBudget(args),
      onFailure: args.onFailure,
      model: args.model,
      effort: args.effort,
      maxAttempts: args.maxAttempts,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  appendEvent(db, {
    objectiveId,
    payload: { type: "objective.created", title: args.title, repoPath: args.repoPath },
  });

  return { objectiveId };
}

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
  const report = db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.objectiveId, objectiveId), eq(artifacts.kind, "report")))
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
