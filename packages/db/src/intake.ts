import {
  newId,
  taskKey,
  type AcceptanceCheck,
  type AcceptanceSpec,
  type Budget,
  type EffortLevel,
  type ObjectiveOnFailure,
} from "@exec/core";
import type { Db } from "./client.js";
import { objectives, tasks } from "./schema.js";
import { appendEvent } from "./store.js";

/**
 * Creating an objective — the one path every front door uses: the CLI's
 * `do` and `run`, and requests sent from the phone. Same validation-free
 * inserts, same events, same defaults, so a request can't behave differently
 * depending on where it was typed.
 */

/** Run options when nothing overrides them. Real runs averaged ~10 turns /
 *  100s for one-file tasks, so "medium" effort is the sensible default. */
export const RUN_DEFAULTS = {
  model: "claude-sonnet-5",
  effort: "medium" as EffortLevel,
  baseRef: "HEAD",
  maxAttempts: 3,
  maxTurns: 30,
  maxWallClockMs: 20 * 60_000,
  onFailure: "escalate" as ObjectiveOnFailure,
};

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
