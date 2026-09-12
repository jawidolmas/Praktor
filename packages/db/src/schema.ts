import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type {
  AcceptanceSpec,
  Budget,
  Checkpoint,
  DecisionOption,
  EventPayload,
  PolicyMatcher,
  TokenUsage,
} from "@exec/core";

/**
 * SQLite schema, deliberately kept Postgres-portable: integer epoch-millis
 * timestamps, text primary keys, and JSON held in text columns (which map to jsonb
 * on Postgres without a data migration). No SQLite-only types are used.
 */

const now = sql`(unixepoch() * 1000)`;

export const objectives = sqliteTable("objectives", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  brief: text("brief").notNull().default(""),
  repoPath: text("repo_path").notNull(),
  baseRef: text("base_ref").notNull().default("HEAD"),
  status: text("status").notNull().default("draft"),
  budget: text("budget", { mode: "json" }).$type<Budget>().notNull(),
  // What to do when a task exhausts its attempts and can't be recovered
  // mechanically: "escalate" (default) raises an L3 decision, "abandon" fails
  // the objective outright, "skip" tolerates it and cascades the tasks that
  // depended on it to "abandoned" so the rest of the objective can still finish.
  onFailure: text("on_failure").notNull().default("escalate"),
  // Defaults for every task this objective's tasks get created with. Needed
  // even before a single task exists: an objective can sit in "draft"
  // (submitted, awaiting decomposition) across a daemon restart, and the
  // daemon reconstructs everything it needs from these rows alone.
  model: text("model").notNull().default("claude-sonnet-5"),
  effort: text("effort").notNull().default("medium"),
  maxAttempts: integer("max_attempts").notNull().default(3),
  // Set once a human has reviewed the diff and merged it into the real repo
  // via `exec-agent approve` or the dashboard's Merge button. Distinct from
  // `status: "done"`, which only means the worker's own acceptance check
  // passed — a worker never merges its own work into your real branch.
  mergedAt: integer("merged_at"),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
});

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    objectiveId: text("objective_id")
      .notNull()
      .references(() => objectives.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    title: text("title").notNull(),
    intent: text("intent").notNull(),
    taskClass: text("task_class").notNull(),
    acceptance: text("acceptance", { mode: "json" })
      .$type<AcceptanceSpec>()
      .notNull(),
    dependsOn: text("depends_on", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default([]),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    budget: text("budget", { mode: "json" }).$type<Budget>().notNull(),
    // How to run the worker, persisted here (not just on `runs`) so the daemon
    // can pick this task up and drive every attempt from the database alone —
    // there is no CLI process left holding these in memory by then.
    model: text("model").notNull().default("claude-sonnet-5"),
    effort: text("effort").notNull().default("medium"),
    ruledOut: text("ruled_out", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default([]),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("tasks_objective_key_idx").on(t.objectiveId, t.key),
    index("tasks_status_idx").on(t.status),
  ],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    objectiveId: text("objective_id").notNull(),
    attempt: integer("attempt").notNull(),
    /** UUID we assign and pass to the SDK, so our row and the transcript agree. */
    sessionId: text("session_id").notNull(),
    model: text("model").notNull(),
    effort: text("effort").notNull().default("high"),
    worktreePath: text("worktree_path").notNull(),
    status: text("status").notNull().default("running"),
    exitReason: text("exit_reason"),
    turns: integer("turns").notNull().default(0),
    usage: text("usage", { mode: "json" }).$type<TokenUsage>().notNull(),
    costUsdEstimate: real("cost_usd_estimate").notNull().default(0),
    startedAt: integer("started_at").notNull().default(now),
    endedAt: integer("ended_at"),
  },
  (t) => [
    uniqueIndex("runs_session_idx").on(t.sessionId),
    index("runs_task_idx").on(t.taskId),
  ],
);

/**
 * Append-only. This is the source of truth; every other table is a projection.
 * Nothing in the system updates or deletes an event row.
 */
export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: integer("ts").notNull().default(now),
    level: text("level").notNull().default("info"),
    objectiveId: text("objective_id"),
    taskId: text("task_id"),
    runId: text("run_id"),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).$type<EventPayload>().notNull(),
  },
  (t) => [
    index("events_ts_idx").on(t.ts),
    index("events_objective_idx").on(t.objectiveId, t.ts),
    index("events_run_idx").on(t.runId, t.ts),
    index("events_type_idx").on(t.type),
  ],
);

export const decisions = sqliteTable(
  "decisions",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    objectiveId: text("objective_id").notNull(),
    taskId: text("task_id"),
    runId: text("run_id"),
    level: text("level").notNull(),
    title: text("title").notNull(),
    context: text("context").notNull(),
    options: text("options", { mode: "json" })
      .$type<DecisionOption[]>()
      .notNull(),
    recommendation: text("recommendation").notNull(),
    risk: text("risk").notNull(),
    blockedTaskIds: text("blocked_task_ids", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default([]),
    status: text("status").notNull().default("open"),
    answer: text("answer"),
    answeredBy: text("answered_by"),
    answeredAt: integer("answered_at"),
    rationale: text("rationale"),
    deadline: integer("deadline"),
    // Set once a push notification for this decision has actually been sent
    // (Telegram today). Null is the "still needs notifying" queue, so the
    // bridge can find pending work with a plain WHERE clause instead of
    // resending on every poll.
    notifiedAt: integer("notified_at"),
    // The bot message carrying this decision's options, so an answer routed
    // back through the same channel (a tapped inline button) can edit that
    // message to show it was answered, instead of leaving a stale button.
    notifiedMessageId: integer("notified_message_id"),
    // Set once an L3 (permanent-failure) decision's answer has actually been
    // applied to the task graph (engine.ts's applyAnsweredFailureDecisions).
    // Necessary, not just tidy: a task can fail, escalate, get reopened, and
    // fail again many times, so its "blocked" status alone can't tell a
    // decision that already had its effect applied apart from a stale one —
    // both look identical (status "answered") once a *later* failure has put
    // the task back in "blocked" for an unrelated, newer reason. Without this,
    // an old already-applied decision gets replayed against the task's
    // current block and wins, silently overriding whatever the actual latest
    // decision said — confirmed live: a task kept being granted more
    // attempts forever because its first-ever "grant more" answer kept
    // getting reapplied, even after later decisions on the same task were
    // answered "abandon" or "accept the failure."
    appliedAt: integer("applied_at"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("decisions_key_idx").on(t.key),
    index("decisions_status_idx").on(t.status),
  ],
);

export const policies = sqliteTable(
  "policies",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    title: text("title").notNull(),
    rationale: text("rationale").notNull().default(""),
    matcher: text("matcher", { mode: "json" })
      .$type<PolicyMatcher>()
      .notNull(),
    severity: text("severity").notNull(),
    action: text("action").notNull(),
    scope: text("scope").notNull().default("global"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("policies_key_idx").on(t.key)],
);

export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey(),
    tier: text("tier").notNull(),
    scopeId: text("scope_id").notNull().default(""),
    title: text("title").notNull(),
    content: text("content").notNull(),
    source: text("source").notNull().default(""),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("memories_tier_scope_idx").on(t.tier, t.scopeId)],
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(), // checkpoint | diff | report | log
    objectiveId: text("objective_id"),
    taskId: text("task_id"),
    runId: text("run_id"),
    content: text("content", { mode: "json" })
      .$type<Checkpoint | Record<string, unknown> | string>()
      .notNull(),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [
    index("artifacts_kind_idx").on(t.kind),
    index("artifacts_run_idx").on(t.runId),
  ],
);

/** Monotonic sequences behind the human-facing DEC-nnn / POLICY-nnn keys. */
export const counters = sqliteTable("counters", {
  name: text("name").primaryKey(),
  value: integer("value").notNull().default(0),
});

/**
 * Small daemon-wide key/value state that doesn't warrant its own table — e.g.
 * the Telegram long-poll cursor, which must survive a daemon restart or a
 * redelivered update could re-answer a decision that already moved on.
 */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type ObjectiveRow = typeof objectives.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type DecisionRow = typeof decisions.$inferSelect;
export type PolicyRow = typeof policies.$inferSelect;
export type MemoryRow = typeof memories.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
