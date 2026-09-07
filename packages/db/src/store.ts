import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import {
  PolicySchema,
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
  tasks,
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
  filter: { objectiveId?: string; runId?: string; since?: number; limit?: number },
) {
  const conditions = [];
  if (filter.objectiveId)
    conditions.push(eq(events.objectiveId, filter.objectiveId));
  if (filter.runId) conditions.push(eq(events.runId, filter.runId));

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

    if (row.blockedTaskIds.length > 0) {
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

export { objectives, tasks, runs, events, decisions, policies, memories, artifacts };
export { isNull };
