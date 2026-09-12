import { and, asc, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import {
  PolicySchema,
  type Budget,
  type DecomposeOutput,
  type EffortLevel,
  type EventLevel,
  type EventPayload,
  type Policy,
  decisionKey,
  newId,
  policyKey,
} from "@exec/core";
import type { Db } from "./client.js";
import {
  artifacts,
  counters,
  decisions,
  events,
  memories,
  objectives,
  policies,
  runs,
  settings,
  tasks,
  type DecisionRow,
  type ObjectiveRow,
  type TaskRow,
} from "./schema.js";

/* ------------------------------------------------------------------ *
 * Event log — append only
 * ------------------------------------------------------------------ */

export interface AppendEventArgs {
  payload: EventPayload;
  level?: EventLevel;
  objectiveId?: string;
  taskId?: string;
  runId?: string;
}

/**
 * Append one event. Nothing in the system ever updates or deletes these rows —
 * projections are rebuilt by replaying them.
 */
export function appendEvent(db: Db, args: AppendEventArgs): void {
  db.insert(events)
    .values({
      ts: Date.now(),
      level: args.level ?? "info",
      objectiveId: args.objectiveId ?? null,
      taskId: args.taskId ?? null,
      runId: args.runId ?? null,
      type: args.payload.type,
      payload: args.payload,
    })
    .run();
}

export function readEvents(
  db: Db,
  /** `since` is an event id cursor (not a timestamp): "rows after the last one I
   *  already have", which is what a polling reader (the dashboard) needs — a
   *  timestamp can collide or go backwards across processes, an autoincrement
   *  id can't. */
  filter: { objectiveId?: string; runId?: string; since?: number; limit?: number },
) {
  const conditions = [];
  if (filter.objectiveId)
    conditions.push(eq(events.objectiveId, filter.objectiveId));
  if (filter.runId) conditions.push(eq(events.runId, filter.runId));
  if (filter.since !== undefined) conditions.push(gt(events.id, filter.since));

  const q = db
    .select()
    .from(events)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(events.ts), asc(events.id))
    .limit(filter.limit ?? 1000);
  return q.all();
}

/* ------------------------------------------------------------------ *
 * Counters — the human-facing DEC-nnn / POLICY-nnn keys
 * ------------------------------------------------------------------ */

/**
 * Atomically take the next value of a named counter.
 *
 * better-sqlite3 is synchronous, so the read-modify-write below cannot interleave
 * within this process. The transaction protects against a second process (the CLI
 * seeding a policy while the daemon runs).
 */
export function nextSeq(db: Db, name: string): number {
  return db.transaction((tx) => {
    const row = tx
      .select()
      .from(counters)
      .where(eq(counters.name, name))
      .get();
    const next = (row?.value ?? 0) + 1;
    if (row) {
      tx.update(counters)
        .set({ value: next })
        .where(eq(counters.name, name))
        .run();
    } else {
      tx.insert(counters).values({ name, value: next }).run();
    }
    return next;
  });
}

export const nextDecisionKey = (db: Db): string =>
  decisionKey(nextSeq(db, "decision"));
export const nextPolicyKey = (db: Db): string =>
  policyKey(nextSeq(db, "policy"));

/* ------------------------------------------------------------------ *
 * Scheduling
 * ------------------------------------------------------------------ */

/**
 * Tasks whose dependencies are all satisfied and which are not already running,
 * blocked or finished.
 *
 * Dependency resolution runs in JS rather than SQL: the per-objective task count is
 * small, and it keeps the query identical on SQLite and Postgres instead of relying
 * on each dialect's JSON operators.
 */
export function readyTasks(db: Db, objectiveId: string): TaskRow[] {
  const all = db
    .select()
    .from(tasks)
    .where(eq(tasks.objectiveId, objectiveId))
    .all();

  const doneIds = new Set(
    all.filter((t) => t.status === "done").map((t) => t.id),
  );

  return all.filter(
    (t) =>
      (t.status === "pending" || t.status === "ready") &&
      t.dependsOn.every((d) => doneIds.has(d)),
  );
}

/** Objectives currently in progress (status exactly "active"), oldest first. */
export function activeObjectives(db: Db): ObjectiveRow[] {
  return db
    .select()
    .from(objectives)
    .where(eq(objectives.status, "active"))
    .orderBy(asc(objectives.createdAt))
    .all();
}

/**
 * Objectives that might still have schedulable work, oldest first — broader
 * than `activeObjectives`, and deliberately not just "active": an
 * objective's own status can lag its task's (e.g. a decision answered by a
 * CLI or the dashboard while the daemon was stopped updates the task but not
 * the objective — see `answerDecision`), and the daemon must still find that
 * work on its next tick rather than treating a "blocked"/"parked" objective
 * as permanently off its list. `readyTasks` is the real gate on whether
 * there's anything to do; this only avoids scanning finished objectives.
 */
export function schedulableObjectives(db: Db): ObjectiveRow[] {
  return db
    .select()
    .from(objectives)
    .where(
      or(
        eq(objectives.status, "active"),
        eq(objectives.status, "blocked"),
        eq(objectives.status, "parked"),
      ),
    )
    .orderBy(asc(objectives.createdAt))
    .all();
}

/** Objectives submitted but not yet broken into tasks — the daemon's planner
 *  picks these up before it looks for ready work, oldest first. */
export function draftObjectives(db: Db): ObjectiveRow[] {
  return db
    .select()
    .from(objectives)
    .where(eq(objectives.status, "draft"))
    .orderBy(asc(objectives.createdAt))
    .all();
}

/**
 * Derive an objective's status purely from the current state of its tasks —
 * the fix for what used to be `setObjectiveStatus(db, objective.id,
 * finalStatus)` at the end of driving a single task, which only ever mirrored
 * that one task and had no way to be right once an objective has more than
 * one. Safe to call repeatedly and from anywhere (end of a task drive, a
 * periodic sweep, after a decision resolves): it never touches an objective
 * already in a terminal state, and setObjectiveStatus itself no-ops when the
 * status wouldn't change.
 */
export function reconcileObjective(db: Db, objectiveId: string): void {
  const objective = db.select().from(objectives).where(eq(objectives.id, objectiveId)).get();
  if (!objective) return;
  const TERMINAL_OBJECTIVE = new Set(["done", "failed", "cancelled"]);
  if (TERMINAL_OBJECTIVE.has(objective.status)) return;

  const all = db.select().from(tasks).where(eq(tasks.objectiveId, objectiveId)).all();
  // Still being planned (a "draft" objective with no tasks yet) — nothing to
  // derive a status from until the planner writes its task graph.
  if (all.length === 0) return;

  if (all.some((t) => t.status === "blocked")) {
    setObjectiveStatus(db, objectiveId, "blocked", "a task is waiting on a decision");
    return;
  }
  if (all.some((t) => t.status === "running")) {
    setObjectiveStatus(db, objectiveId, "active");
    return;
  }
  if (all.some((t) => t.status === "parked")) {
    setObjectiveStatus(db, objectiveId, "parked", "a task is waiting out a rate limit");
    return;
  }
  if (all.some((t) => t.status === "pending" || t.status === "ready")) {
    setObjectiveStatus(db, objectiveId, "active");
    return;
  }

  // Every task has reached a terminal state: done, failed, or abandoned.
  if (all.some((t) => t.status === "failed")) {
    if (objective.onFailure === "skip") {
      setObjectiveStatus(db, objectiveId, "done", "completed with one or more tasks skipped after failure");
      return;
    }
    // Under "escalate", a task only ever reaches "failed" once a person has
    // resolved the L3 decision raised for it — answer "A" (abandon) already
    // fails the objective directly, at the point it's applied, so the only
    // way a "failed" task reaches here still un-terminal is answer "C"
    // (accept and continue). Whether that failure is still fatal is exactly
    // "was there ever a decision on it that didn't say abandon" — reusing
    // the decisions table as the record of what was actually blessed, rather
    // than adding a second place that tracks the same fact.
    const stillFatal = all.some((t) => {
      if (t.status !== "failed") return false;
      const resolutions = db
        .select()
        .from(decisions)
        .where(and(eq(decisions.taskId, t.id), eq(decisions.level, "L3"), eq(decisions.status, "answered")))
        .all();
      return !resolutions.some((d) => d.answer !== "A");
    });
    setObjectiveStatus(
      db,
      objectiveId,
      stillFatal ? "failed" : "done",
      stillFatal ? "a task failed permanently" : "completed after accepting a task's failure",
    );
    return;
  }
  setObjectiveStatus(db, objectiveId, "done");
}

/** Reconcile every objective that isn't already finished — a periodic sweep
 *  so a status change made outside the task-driving loop (a decision
 *  answered from the CLI or dashboard while the daemon sat idle) is picked up
 *  on the next tick regardless of which objective it belonged to. */
export function reconcileObjectives(db: Db): void {
  for (const objective of schedulableObjectives(db)) {
    reconcileObjective(db, objective.id);
  }
}

/**
 * Mark every task that transitively depends on `taskId` as "abandoned" — it
 * can never become ready, since `readyTasks` requires every dependency to
 * reach "done", and this one will not. Used when a permanently failed task's
 * objective is set to tolerate the failure (onFailure "skip" or "abandon")
 * rather than treat the whole task graph as stuck. Only touches tasks not
 * already in a terminal state, so it's safe to call more than once.
 */
export function cascadeAbandon(db: Db, taskId: string): void {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) return;
  const all = db.select().from(tasks).where(eq(tasks.objectiveId, task.objectiveId)).all();

  const TERMINAL_TASK = new Set(["done", "failed", "abandoned"]);
  const unreachable = new Set<string>([taskId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of all) {
      if (unreachable.has(t.id) || TERMINAL_TASK.has(t.status)) continue;
      if (t.dependsOn.some((d) => unreachable.has(d))) {
        unreachable.add(t.id);
        changed = true;
      }
    }
  }
  unreachable.delete(taskId); // the failed task itself keeps its own status

  for (const id of unreachable) {
    setTaskStatus(db, id, "abandoned", `depends on a task that will not complete (${task.key})`);
  }
}

export interface CreateTasksFromPlanArgs {
  objectiveId: string;
  plan: DecomposeOutput;
  model: string;
  effort: EffortLevel;
  maxAttempts: number;
  budget: Budget;
}

/**
 * Write a `decompose` brain call's task graph into the database and flip the
 * objective from "draft" to "active" — atomically, so a crash partway through
 * (daemon killed mid-write) leaves the objective exactly as it was (still
 * "draft", no tasks), and the next planner tick simply tries again, rather
 * than leaving a half-written graph that a retry would collide with on the
 * (objectiveId, key) unique index.
 *
 * Two passes because `dependsOn` in the plan refers to other tasks by their
 * human-readable key ("T-001"), not the real ids `readyTasks` needs — every
 * task's id must exist before any `dependsOn` array can be resolved.
 */
export function createTasksFromPlan(db: Db, args: CreateTasksFromPlanArgs): TaskRow[] {
  const now = Date.now();
  const idByKey = new Map<string, string>();
  for (const t of args.plan.tasks) idByKey.set(t.key, newId());

  const written: TaskRow[] = db.transaction((tx) => {
    for (const t of args.plan.tasks) {
      tx.insert(tasks)
        .values({
          id: idByKey.get(t.key)!,
          objectiveId: args.objectiveId,
          key: t.key,
          title: t.title,
          intent: t.intent,
          taskClass: t.taskClass,
          // The plan's checks omit timeoutMs (the planner has no reason to
          // pick one) — default it the same way `parseCheck` does for a
          // human-authored --check.
          acceptance: { checks: t.acceptance.checks.map((c) => ({ ...c, timeoutMs: 10 * 60_000 })) },
          dependsOn: [],
          status: "pending",
          attempts: 0,
          maxAttempts: args.maxAttempts,
          budget: args.budget,
          model: args.model,
          effort: args.effort,
          ruledOut: [],
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    const rows: TaskRow[] = [];
    for (const t of args.plan.tasks) {
      const id = idByKey.get(t.key)!;
      const dependsOn = t.dependsOn
        .map((k) => idByKey.get(k))
        .filter((x): x is string => x !== undefined);
      const status = dependsOn.length === 0 ? "ready" : "pending";
      tx.update(tasks).set({ dependsOn, status, updatedAt: now }).where(eq(tasks.id, id)).run();
      rows.push(tx.select().from(tasks).where(eq(tasks.id, id)).get()!);
    }

    tx.update(objectives)
      .set({ status: "active", updatedAt: now })
      .where(eq(objectives.id, args.objectiveId))
      .run();

    return rows;
  });

  appendEvent(db, {
    objectiveId: args.objectiveId,
    payload: {
      type: "objective.status_changed",
      from: "draft",
      to: "active",
      reason: `decomposed into ${written.length} task(s)`,
    },
  });
  for (const row of written) {
    appendEvent(db, {
      objectiveId: args.objectiveId,
      taskId: row.id,
      payload: { type: "task.created", key: row.key, title: row.title, dependsOn: row.dependsOn },
    });
  }

  return written;
}

/**
 * Mark every not-yet-finished task in an objective "abandoned" — the shared
 * core of "call the whole thing off," used both by an explicit user abandon
 * and by the engine when a permanent task failure takes the whole objective
 * down with it (onFailure "abandon", or an "A" answer to an escalation).
 *
 * Deliberately every task in the objective, not just the failed one's
 * dependents (`cascadeAbandon`): a task with no dependency relationship to
 * the one that failed — a sibling branch of the graph — still has nowhere to
 * go once the objective itself is terminal, since `schedulableObjectives`
 * excludes it from ever being picked up again. Confirmed live: without this,
 * abandoning an objective over one failed task left its unrelated sibling
 * tasks sitting in "pending"/"ready" forever — not abandoned, not run, just
 * silently orphaned, contradicting exactly what "abandon the objective —
 * everything else in it is dropped too" is supposed to mean.
 */
export function abandonAllTasks(db: Db, objectiveId: string, reason: string): void {
  const NON_TERMINAL_TASK = new Set(["pending", "ready", "running", "verifying", "blocked", "parked"]);
  for (const task of db.select().from(tasks).where(eq(tasks.objectiveId, objectiveId)).all()) {
    if (NON_TERMINAL_TASK.has(task.status)) {
      setTaskStatus(db, task.id, "abandoned", reason);
    }
  }
}

/**
 * The explicit "I'm calling this off" path — the "or explicitly abandoned by
 * the user" clause of the objective guarantee, which otherwise has no code
 * path at all. Marks every task not already finished as "abandoned" rather
 * than deleting anything, so the record of what was attempted survives. A
 * task genuinely "running" right now is left alone — there is no cross-process
 * way to interrupt an in-flight worker session yet, so it runs to its own
 * conclusion; `reconcileObjective` no-ops on a terminal objective either way,
 * so that one extra attempt cannot resurrect a cancelled objective.
 */
export function cancelObjective(db: Db, objectiveId: string): boolean {
  const objective = db.select().from(objectives).where(eq(objectives.id, objectiveId)).get();
  if (!objective) return false;
  const TERMINAL_OBJECTIVE = new Set(["done", "failed", "cancelled"]);
  if (TERMINAL_OBJECTIVE.has(objective.status)) return false;

  abandonAllTasks(db, objectiveId, "objective abandoned by user");
  setObjectiveStatus(db, objectiveId, "cancelled", "abandoned by user");
  return true;
}

export function setObjectiveStatus(
  db: Db,
  objectiveId: string,
  status: string,
  reason?: string,
): void {
  const before = db.select().from(objectives).where(eq(objectives.id, objectiveId)).get();
  if (!before || before.status === status) return;

  db.update(objectives)
    .set({ status, updatedAt: Date.now() })
    .where(eq(objectives.id, objectiveId))
    .run();

  appendEvent(db, {
    objectiveId,
    payload: {
      type: "objective.status_changed",
      from: before.status,
      to: status,
      ...(reason === undefined ? {} : { reason }),
    },
  });
}

export function setTaskStatus(
  db: Db,
  taskId: string,
  status: string,
  reason?: string,
): void {
  const before = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!before || before.status === status) return;

  db.update(tasks)
    .set({ status, updatedAt: Date.now() })
    .where(eq(tasks.id, taskId))
    .run();

  appendEvent(db, {
    objectiveId: before.objectiveId,
    taskId,
    payload: {
      type: "task.status_changed",
      from: before.status as never,
      to: status as never,
      ...(reason === undefined ? {} : { reason }),
    },
  });
}

/** Record approaches that failed, so a later attempt is told not to repeat them. */
export function addRuledOut(db: Db, taskId: string, entries: string[]): void {
  if (entries.length === 0) return;
  const row = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!row) return;
  const merged = Array.from(new Set([...row.ruledOut, ...entries]));
  db.update(tasks)
    .set({ ruledOut: merged, updatedAt: Date.now() })
    .where(eq(tasks.id, taskId))
    .run();
}

/* ------------------------------------------------------------------ *
 * Decisions
 * ------------------------------------------------------------------ */

export function openDecisions(db: Db, objectiveId?: string) {
  return db
    .select()
    .from(decisions)
    .where(
      objectiveId
        ? and(
            eq(decisions.status, "open"),
            eq(decisions.objectiveId, objectiveId),
          )
        : eq(decisions.status, "open"),
    )
    .orderBy(desc(decisions.createdAt))
    .all();
}

export interface AnswerDecisionArgs {
  key: string;
  answer: string;
  answeredBy: string;
  rationale?: string;
}

/**
 * Answer a decision and unblock exactly the tasks that were waiting on it.
 *
 * The whole thing is one transaction so a decision can never be recorded without
 * its dependent tasks being released, or vice versa.
 */
export function answerDecision(db: Db, args: AnswerDecisionArgs): boolean {
  return db.transaction((tx) => {
    const row = tx
      .select()
      .from(decisions)
      .where(eq(decisions.key, args.key))
      .get();
    if (!row || row.status !== "open") return false;

    tx.update(decisions)
      .set({
        status: "answered",
        answer: args.answer,
        answeredBy: args.answeredBy,
        answeredAt: Date.now(),
        rationale: args.rationale ?? null,
      })
      .where(eq(decisions.key, args.key))
      .run();

    // An L2 decision blocks one in-flight attempt on a live question — once
    // answered, the task it blocked is simply schedulable again. An L3
    // decision blocks a task that has already permanently failed; its answer
    // ("abandon", "grant more attempts", "accept and move on") means
    // something different for the task graph than "unblock," and only the
    // daemon (engine.ts's applyAnsweredFailureDecisions) knows how to apply
    // it. Generically flipping the task back to "pending" here would silently
    // resume a task the human may have just chosen to abandon.
    if (row.blockedTaskIds.length > 0 && row.level !== "L3") {
      tx.update(tasks)
        .set({ status: "pending", updatedAt: Date.now() })
        .where(inArray(tasks.id, row.blockedTaskIds))
        .run();
    }

    tx.insert(events)
      .values({
        ts: Date.now(),
        level: "info",
        objectiveId: row.objectiveId,
        taskId: row.taskId,
        runId: row.runId,
        type: "decision.answered",
        payload: {
          type: "decision.answered",
          key: args.key,
          answer: args.answer,
          answeredBy: args.answeredBy,
        },
      })
      .run();

    return true;
  });
}

/** Open decisions no push notification has gone out for yet. */
export function unnotifiedDecisions(db: Db): DecisionRow[] {
  return db
    .select()
    .from(decisions)
    .where(and(eq(decisions.status, "open"), isNull(decisions.notifiedAt)))
    .orderBy(asc(decisions.createdAt))
    .all();
}

/** Record that a push notification for this decision was sent, so the
 *  bridge's poll doesn't resend it — and remember which message, so an
 *  answer routed back through the same channel can edit it. */
export function markDecisionNotified(
  db: Db,
  decisionId: string,
  messageId: number,
): void {
  db.update(decisions)
    .set({ notifiedAt: Date.now(), notifiedMessageId: messageId })
    .where(eq(decisions.id, decisionId))
    .run();
}

/* ------------------------------------------------------------------ *
 * Settings — small daemon-wide key/value state
 * ------------------------------------------------------------------ */

export function getSetting(db: Db, key: string): string | undefined {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

/* ------------------------------------------------------------------ *
 * Policies
 * ------------------------------------------------------------------ */

/**
 * Enabled policies applying to an objective: global ones plus objective-scoped
 * ones, validated back into the domain `Policy` type.
 *
 * The DB column types are loose (`severity`/`action` are plain `text`, matching
 * SQLite) so a bad row fails here, at the trust boundary, rather than surfacing
 * as a confusing type error at every call site downstream.
 */
export function activePolicies(db: Db, objectiveId: string): Policy[] {
  const rows = db
    .select()
    .from(policies)
    .where(
      and(
        eq(policies.enabled, true),
        or(
          eq(policies.scope, "global"),
          eq(policies.scope, `objective:${objectiveId}`),
        ),
      ),
    )
    .all();
  return rows.map((row) => PolicySchema.parse(row));
}

/* ------------------------------------------------------------------ *
 * Artifacts
 * ------------------------------------------------------------------ */

export function writeArtifact(
  db: Db,
  args: {
    kind: string;
    content: unknown;
    objectiveId?: string;
    taskId?: string;
    runId?: string;
  },
): string {
  const id = newId();
  db.insert(artifacts)
    .values({
      id,
      kind: args.kind,
      objectiveId: args.objectiveId ?? null,
      taskId: args.taskId ?? null,
      runId: args.runId ?? null,
      content: args.content as never,
      createdAt: Date.now(),
    })
    .run();
  return id;
}

/** Most recent checkpoint for a task, used to seed a respawned worker. */
export function latestCheckpoint(db: Db, taskId: string) {
  return db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.taskId, taskId), eq(artifacts.kind, "checkpoint")))
    .orderBy(desc(artifacts.createdAt))
    .limit(1)
    .get();
}

/* ------------------------------------------------------------------ *
 * Approval — the human review checkpoint before anything reaches the real repo
 * ------------------------------------------------------------------ */

export interface AcceptedRun {
  taskId: string;
  attempt: number;
  repoPath: string;
  baseRef: string;
}

/**
 * The run whose branch actually holds the accepted work for an objective —
 * only meaningful once its task is "done" (verify passed), since that's the
 * one state where exactly one run is known to have succeeded. Only v0.1's
 * one-task-per-objective shape is assumed here; a real DAG would need to
 * pick a specific task, not "the" task.
 */
export function acceptedRun(db: Db, objectiveId: string): AcceptedRun | undefined {
  const objective = db.select().from(objectives).where(eq(objectives.id, objectiveId)).get();
  if (!objective || objective.status !== "done") return undefined;

  const task = db.select().from(tasks).where(eq(tasks.objectiveId, objectiveId)).get();
  if (!task) return undefined;

  const run = db
    .select()
    .from(runs)
    .where(eq(runs.taskId, task.id))
    .orderBy(desc(runs.attempt))
    .limit(1)
    .get();
  if (!run) return undefined;

  return { taskId: task.id, attempt: run.attempt, repoPath: objective.repoPath, baseRef: objective.baseRef };
}

export function markObjectiveMerged(db: Db, objectiveId: string): void {
  db.update(objectives)
    .set({ mergedAt: Date.now(), updatedAt: Date.now() })
    .where(eq(objectives.id, objectiveId))
    .run();
}

export { objectives, tasks, runs, events, decisions, policies, memories, artifacts, settings };
export { isNull };
