import { existsSync, readFileSync, statSync } from "node:fs";
import { and, desc, eq, or } from "drizzle-orm";
import { isEvent, type EventPayload } from "@exec/core";
import {
  acceptedRuns,
  answerDecision,
  appendEvent,
  approximateHealthSince,
  artifacts,
  AUTOSTART_MODE_EXPLANATIONS,
  autostartStatus,
  decisions,
  events,
  findRunningDaemon,
  listMemories,
  listObjectives,
  markObjectiveMerged,
  objectives,
  policies,
  readEvents,
  recoveredTasksSince,
  releaseApproveLock,
  runs,
  tasks,
  tryAcquireApproveLock,
  type AutostartMode,
  type AutostartStatus,
  type Db,
  type HealthApprox,
  type RecoveredTask,
} from "@exec/db";
import { attemptBranchName, computeApprovalDiffs, graphJsonPathFor, mergeAndPushAll } from "@exec/worker";
import { describeEvent } from "./format.js";

export { listObjectives };
export type { ObjectiveSummary } from "@exec/db";

/**
 * Data access for the dashboard. Almost every function here only ever
 * selects — the daemon is the sole process actually driving work, and
 * SQLite's WAL mode is what lets this read concurrently with it without
 * blocking it. `answerOpenDecision` is the one write: answering a decision
 * is safe for any process to do (the daemon only polls for the answer, it
 * doesn't own the decision), which is exactly what makes it possible to
 * answer one from here instead of only from the terminal that submitted it.
 */

export interface DaemonStatusInfo {
  running: boolean;
  pid?: number;
  autostart: AutostartStatus;
  /** Plain-language explanation per mode, straight from `@exec/db` — the one
   *  place this text is written, so the CLI's own "which mode?" prompt and
   *  the dashboard's hint can never drift into saying different things about
   *  what "logon" or "boot" actually does. */
  autostartModes: Record<AutostartMode, string>;
}

// `autostartStatus()` shells out to PowerShell to query Task Scheduler —
// confirmed live at ~1.4s per call, every time, with no caching of its own.
// `getDaemonStatus` is what `/api/daemon` calls on every poll of the
// dashboard's most frequently hit endpoint (every few seconds), and since
// better-sqlite3 and execFileSync are both synchronous, that 1.4s doesn't
// just make one response slow — it blocks Node's single thread, stalling
// every other concurrent request (other tabs, SSE streams, decision answers)
// for the same window. Autostart registration only ever changes via an
// explicit install/uninstall command, never on its own, so a cached value up
// to `AUTOSTART_CACHE_MS` old costs nothing real. Refreshed on a background
// interval, not lazily on request, so no request path ever pays that cost.
const AUTOSTART_CACHE_MS = 30_000;
let cachedAutostart: AutostartStatus = { installed: false };

function refreshAutostartCache(fetcher: () => AutostartStatus): void {
  cachedAutostart = fetcher();
}

/** Starts the background refresh — called once, at dashboard startup. Takes
 *  the fetcher as a parameter (defaulting to the real one) purely so a test
 *  can drive this with a fast, deterministic stand-in instead of a real
 *  PowerShell call. */
export function startAutostartStatusCache(
  fetcher: () => AutostartStatus = autostartStatus,
  intervalMs = AUTOSTART_CACHE_MS,
): void {
  refreshAutostartCache(fetcher);
  setInterval(() => refreshAutostartCache(fetcher), intervalMs).unref();
}

/** Whether the daemon is actually running right now, and whether it's
 *  registered to come back on its own after a reboot — the second half is
 *  what "walk away for three days" depends on, and there's otherwise no way
 *  to tell from the dashboard that it was never set up at all. `running`/
 *  `pid` are read fresh every call (a cheap pidfile + process-alive check);
 *  only the slow autostart half is cached — see above. */
export function getDaemonStatus(): DaemonStatusInfo {
  const pid = findRunningDaemon();
  return {
    running: pid !== undefined,
    ...(pid !== undefined ? { pid } : {}),
    autostart: cachedAutostart,
    autostartModes: AUTOSTART_MODE_EXPLANATIONS,
  };
}


export interface ObjectiveDetail {
  objective: typeof objectives.$inferSelect;
  tasks: (typeof tasks.$inferSelect)[];
  runs: (typeof runs.$inferSelect)[];
  decisions: (typeof decisions.$inferSelect)[];
}

export function getObjective(db: Db, id: string): ObjectiveDetail | undefined {
  const objective = db.select().from(objectives).where(eq(objectives.id, id)).get();
  if (!objective) return undefined;

  return {
    objective,
    tasks: db.select().from(tasks).where(eq(tasks.objectiveId, id)).all(),
    runs: db.select().from(runs).where(eq(runs.objectiveId, id)).orderBy(desc(runs.startedAt)).all(),
    decisions: db
      .select()
      .from(decisions)
      .where(eq(decisions.objectiveId, id))
      .orderBy(desc(decisions.createdAt))
      .all(),
  };
}

export interface DisplayEvent {
  id: number;
  ts: number;
  level: string;
  taskId: string | null;
  runId: string | null;
  type: string;
  kind: string;
  text: string;
  /** Which model actually did/reviewed/diagnosed this, when the event carries
   *  one — run.started, review.result, diagnose.result and brain.call all do.
   *  Pulled out to its own field (rather than left buried in `text`) so a
   *  feed can render it as its own badge — the "which agent did the work"
   *  the plain log line never made a first-class fact. */
  model: string | null;
}

/** The handful of event types that carry a `model` field — everything else
 *  (task lifecycle, policy checks, decisions, etc.) has no agent attached to
 *  it and `model` is simply omitted for those rows. */
function extractModel(payload: EventPayload): string | null {
  if (payload.type === "run.started") return payload.model;
  if (payload.type === "review.result" || payload.type === "diagnose.result" || payload.type === "brain.call") {
    return payload.model ?? null;
  }
  return null;
}

export function getObjectiveEvents(db: Db, objectiveId: string, sinceId?: number): DisplayEvent[] {
  const rows = readEvents(db, {
    objectiveId,
    limit: 2000,
    ...(sinceId !== undefined ? { since: sinceId } : {}),
  });
  return rows.map((row) => {
    const display = describeEvent(row.payload);
    return {
      id: row.id,
      ts: row.ts,
      level: row.level,
      taskId: row.taskId,
      runId: row.runId,
      model: extractModel(row.payload),
      type: row.type,
      kind: display.kind,
      text: display.text,
    };
  });
}

export function listOpenDecisions(db: Db) {
  return db
    .select({
      id: decisions.id,
      key: decisions.key,
      objectiveId: decisions.objectiveId,
      title: decisions.title,
      context: decisions.context,
      options: decisions.options,
      level: decisions.level,
      risk: decisions.risk,
      recommendation: decisions.recommendation,
      createdAt: decisions.createdAt,
      objectiveTitle: objectives.title,
    })
    .from(decisions)
    .leftJoin(objectives, eq(decisions.objectiveId, objectives.id))
    .where(eq(decisions.status, "open"))
    .orderBy(desc(decisions.createdAt))
    .all();
}

/** Every decision ever raised, newest first — open and resolved alike. This
 *  is the system-wide audit trail: `listOpenDecisions` only ever shows what's
 *  still blocking someone, so once a decision is answered it disappears from
 *  that view entirely. Widened column set (answeredBy/rationale/notifiedAt)
 *  over `listOpenDecisions` on purpose — this is the one place a viewer can
 *  ask "who decided this, through what channel, and did Telegram actually
 *  notify anyone" after the fact. */
export function listDecisionHistory(db: Db, limit = 300) {
  return db
    .select({
      id: decisions.id,
      key: decisions.key,
      objectiveId: decisions.objectiveId,
      taskId: decisions.taskId,
      title: decisions.title,
      context: decisions.context,
      options: decisions.options,
      level: decisions.level,
      risk: decisions.risk,
      recommendation: decisions.recommendation,
      status: decisions.status,
      answer: decisions.answer,
      answeredBy: decisions.answeredBy,
      answeredAt: decisions.answeredAt,
      rationale: decisions.rationale,
      notifiedAt: decisions.notifiedAt,
      createdAt: decisions.createdAt,
      objectiveTitle: objectives.title,
    })
    .from(decisions)
    .leftJoin(objectives, eq(decisions.objectiveId, objectives.id))
    .orderBy(desc(decisions.createdAt))
    .limit(limit)
    .all();
}

export function listPolicies(db: Db) {
  return db.select().from(policies).orderBy(policies.key).all();
}

export function listProfile(db: Db) {
  return listMemories(db, "permanent");
}

/** Answer an open decision from the dashboard. Returns false if it was
 *  already answered elsewhere (another tab, the CLI, `exec-agent decide`) or
 *  the key doesn't exist — never overwrites an existing answer. */
export function answerOpenDecision(
  db: Db,
  args: { key: string; answer: string; answeredBy: string },
): boolean {
  return answerDecision(db, args);
}

export interface ApprovalBranch {
  taskId: string;
  taskTitle: string;
  branch: string;
  diff: string;
}

export interface ApprovalStatus {
  /** True only when there's at least one real diff sitting there, unmerged,
   *  ready for a human "yes" — the one case the dashboard shows diffs and a
   *  button for. */
  eligible: boolean;
  alreadyMerged: boolean;
  mergedAt?: number;
  reason?: string;
  repoPath?: string;
  branches?: ApprovalBranch[];
}

/** What the "Review & Approve" panel needs: one diff per task that reached
 *  "done" (an objective can decompose into several — see `acceptedRuns`), or
 *  a plain reason there's nothing to approve yet, or, distinctly,
 *  confirmation that it's already been merged. Computing diffs means running
 *  git against the user's real repo — read-only (`git diff`), same trust
 *  level as everything else here, just pointed at a different path than a
 *  worktree. */
export function getApprovalStatus(db: Db, objectiveId: string): ApprovalStatus {
  const objective = db.select().from(objectives).where(eq(objectives.id, objectiveId)).get();
  if (!objective) return { eligible: false, alreadyMerged: false, reason: "No such objective." };
  if (objective.mergedAt) {
    return { eligible: false, alreadyMerged: true, mergedAt: objective.mergedAt };
  }

  const accepted = acceptedRuns(db, objectiveId);
  if (accepted.length === 0) {
    return {
      eligible: false,
      alreadyMerged: false,
      reason: objective.status === "done" ? "No accepted run was found." : `Not done yet (status: ${objective.status}).`,
    };
  }

  const taskById = new Map(
    db.select().from(tasks).where(eq(tasks.objectiveId, objectiveId)).all().map((t) => [t.id, t] as const),
  );
  const branchNames = accepted.map((a) => attemptBranchName(a.taskId, a.attempt));
  const diffs = computeApprovalDiffs({ repoPath: accepted[0]!.repoPath, baseRef: accepted[0]!.baseRef }, branchNames);
  const branches: ApprovalBranch[] = accepted.map((a, i) => ({
    taskId: a.taskId,
    taskTitle: taskById.get(a.taskId)?.title ?? "(task)",
    branch: diffs[i]!.branch,
    diff: diffs[i]!.diff,
  }));

  if (branches.every((b) => !b.diff.trim())) {
    return { eligible: false, alreadyMerged: false, reason: "Every accepted branch has nothing beyond its base — nothing to approve." };
  }

  return { eligible: true, alreadyMerged: false, repoPath: accepted[0]!.repoPath, branches };
}

export interface ApproveResult {
  ok: boolean;
  message: string;
  /** Per branch, so a partial failure (a real merge conflict between two
   *  accepted branches, confirmed live — two tasks independently created the
   *  same file with different content) shows which branch and why, instead
   *  of a single generic message that reads like the whole thing failed even
   *  though some branches landed and stayed landed. */
  branches?: { branch: string; merged: boolean; message: string }[];
}

/** Merge and push every accepted branch into the real repo, gated on the
 *  dashboard's Merge button having just been clicked — that click is the
 *  human "yes" this operation requires, the same as the CLI's y/N prompt. */
export function approveObjective(db: Db, objectiveId: string, approvedBy: string): ApproveResult {
  const objective = db.select().from(objectives).where(eq(objectives.id, objectiveId)).get();
  if (!objective) return { ok: false, message: "No such objective." };
  if (objective.mergedAt) return { ok: false, message: "Already merged." };

  const accepted = acceptedRuns(db, objectiveId);
  if (accepted.length === 0) return { ok: false, message: "Nothing to approve." };

  // Confirmed live: the CLI and the dashboard both merge and push straight
  // into the real repo's working directory, with nothing stopping both from
  // doing that to the same objective at once. The lock is shared with the
  // CLI's own approve command (same DB row), so whichever gets there first
  // wins and the other gets a clear "already in progress" instead of an
  // accidental race between two git checkout/merge sequences.
  const lock = tryAcquireApproveLock(db, objectiveId, approvedBy);
  if (!lock.acquired) {
    return { ok: false, message: `Already being approved elsewhere (by ${lock.heldBy ?? "another session"}) — try again shortly.` };
  }

  try {
    const branchNames = accepted.map((a) => attemptBranchName(a.taskId, a.attempt));
    const result = mergeAndPushAll({ repoPath: accepted[0]!.repoPath, baseRef: accepted[0]!.baseRef }, branchNames);

    if (result.allMerged) {
      markObjectiveMerged(db, objectiveId);
      appendEvent(db, {
        objectiveId,
        payload: {
          type: "objective.approved",
          branch: branchNames.join(", "),
          baseRef: result.baseBranch,
          pushed: result.pushed,
          approvedBy,
        },
      });
    }

    return { ok: result.allMerged, message: result.message, branches: result.branches };
  } finally {
    releaseApproveLock(db, objectiveId);
  }
}

/* ------------------------------------------------------------------ *
 * Health & recovery — "is this healthy" and "what did it fix itself"
 * ------------------------------------------------------------------ */

export interface HealthSnapshot {
  health: HealthApprox;
  recovered: RecoveredTask[];
  windowMs: number;
}

/** Wraps two functions `@exec/db` already computes for the Telegram morning
 *  digest (`approximateHealthSince`/`recoveredTasksSince`) but that, until
 *  now, never reached the dashboard — the digest was the only consumer. */
export function getHealthSnapshot(db: Db, windowMs = 7 * 24 * 60 * 60 * 1000): HealthSnapshot {
  const since = Date.now() - windowMs;
  return {
    health: approximateHealthSince(db, since),
    recovered: recoveredTasksSince(db, since),
    windowMs,
  };
}

/* ------------------------------------------------------------------ *
 * Cost & model attribution
 * ------------------------------------------------------------------ */

export interface ModelCost {
  model: string;
  runs: number;
  totalCostUsd: number;
  totalTokens: number;
}

export interface CostRollup {
  totalCostUsd: number;
  totalTokens: number;
  workerCostUsd: number;
  judgeCostUsd: number;
  diagnoserCostUsd: number;
  byModel: ModelCost[];
}

/** Every dollar this installation has spent, broken down by which worker
 *  model earned it and separated from what the judge and diagnoser spent
 *  independently reviewing that work — the two brain calls whose cost used
 *  to be computed and immediately discarded (see events.ts's `ReviewResult`/
 *  `DiagnoseResult`). Full table scans are fine at this tool's scale (a
 *  single operator's own run history), same tradeoff `listObjectives`
 *  already makes. */
export function getCostRollup(db: Db): CostRollup {
  const runRows = db.select().from(runs).all();
  const byModel = new Map<string, ModelCost>();
  let workerCostUsd = 0;
  let totalTokens = 0;
  for (const r of runRows) {
    const tokens = r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheCreation;
    workerCostUsd += r.costUsdEstimate;
    totalTokens += tokens;
    const entry = byModel.get(r.model) ?? { model: r.model, runs: 0, totalCostUsd: 0, totalTokens: 0 };
    entry.runs += 1;
    entry.totalCostUsd += r.costUsdEstimate;
    entry.totalTokens += tokens;
    byModel.set(r.model, entry);
  }

  let judgeCostUsd = 0;
  let diagnoserCostUsd = 0;
  const brainRows = db
    .select()
    .from(events)
    .where(or(eq(events.type, "review.result"), eq(events.type, "diagnose.result")))
    .all();
  for (const row of brainRows) {
    if (isEvent(row.payload, "review.result")) judgeCostUsd += row.payload.costUsdEstimate ?? 0;
    if (isEvent(row.payload, "diagnose.result")) diagnoserCostUsd += row.payload.costUsdEstimate ?? 0;
  }

  return {
    totalCostUsd: workerCostUsd + judgeCostUsd + diagnoserCostUsd,
    totalTokens,
    workerCostUsd,
    judgeCostUsd,
    diagnoserCostUsd,
    byModel: Array.from(byModel.values()).sort((a, b) => b.totalCostUsd - a.totalCostUsd),
  };
}

/* ------------------------------------------------------------------ *
 * Reports — the rich prose artifact (full judge reasoning, full
 * diagnosis, failed-check output) that until now only ever lived in the
 * `artifacts` table with no API route reading it back out.
 * ------------------------------------------------------------------ */

export interface ObjectiveReports {
  objectiveReport: string | null;
  taskReports: Record<string, string>;
}

export function getReports(db: Db, objectiveId: string): ObjectiveReports {
  const rows = db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.objectiveId, objectiveId), eq(artifacts.kind, "report")))
    .orderBy(desc(artifacts.createdAt))
    .all();

  let objectiveReport: string | null = null;
  const taskReports: Record<string, string> = {};
  // Newest first, and a task can be reported on more than once across
  // retries — first write per key (objective-level, or a given taskId) wins,
  // which is exactly the newest one given the ordering above.
  for (const row of rows) {
    if (typeof row.content !== "string") continue;
    if (!row.taskId) {
      if (objectiveReport === null) objectiveReport = row.content;
    } else if (!(row.taskId in taskReports)) {
      taskReports[row.taskId] = row.content;
    }
  }
  return { objectiveReport, taskReports };
}

/* ------------------------------------------------------------------ *
 * Knowledge graph — a summary of the per-repo graphify graph (see
 * packages/worker/src/graphify.ts), which the worker/judge/diagnoser already
 * have MCP access to but which was otherwise invisible outside tool-call
 * names in the event log. This reads the daemon's already-built graph.json
 * directly off disk — it must never shell out to `graphify` itself, only
 * `graphJsonPathFor` (a pure path computation, no subprocess).
 * ------------------------------------------------------------------ */

export interface GraphConfidenceTally {
  extracted: number;
  inferred: number;
  ambiguous: number;
}

export interface GraphTopNode {
  label: string;
  sourceFile?: string;
  degree: number;
}

export interface GraphStats {
  available: boolean;
  repoPath: string;
  graphPath: string;
  nodeCount?: number;
  edgeCount?: number;
  communityCount?: number;
  fileCount?: number;
  confidence?: GraphConfidenceTally;
  topNodes?: GraphTopNode[];
  /** graph.json's mtime — not graphify's own `built_at_commit`, which
   *  resolves `git HEAD` from wherever `GRAPHIFY_OUT` points; for Praktor
   *  that's the external cache dir, not the real repo, so it isn't reliably
   *  present. */
  builtAt?: number;
}

const TOP_NODES_LIMIT = 8;

export function getGraphStats(db: Db, objectiveId: string): GraphStats | undefined {
  const objective = db.select().from(objectives).where(eq(objectives.id, objectiveId)).get();
  if (!objective) return undefined;

  const graphPath = graphJsonPathFor(objective.repoPath);
  if (!existsSync(graphPath)) {
    return { available: false, repoPath: objective.repoPath, graphPath };
  }

  let data: { nodes?: unknown; links?: unknown; edges?: unknown };
  try {
    data = JSON.parse(readFileSync(graphPath, "utf8"));
  } catch {
    // Corrupt or mid-write — treat the same as "not built yet" rather than
    // failing the whole endpoint over a transient read.
    return { available: false, repoPath: objective.repoPath, graphPath };
  }

  const nodes = Array.isArray(data.nodes) ? (data.nodes as Record<string, unknown>[]) : [];
  // The default (clustered) export stores edges under "links"; only a
  // --no-cluster export (which Praktor never requests) uses "edges" — same
  // fallback graphify's own export.py::prune_dangling_edges applies.
  const links = Array.isArray(data.links)
    ? (data.links as Record<string, unknown>[])
    : Array.isArray(data.edges)
      ? (data.edges as Record<string, unknown>[])
      : [];

  const communities = new Set<unknown>();
  const files = new Set<string>();
  const nodeById = new Map<string, Record<string, unknown>>();
  for (const node of nodes) {
    const id = node["id"];
    if (typeof id === "string") nodeById.set(id, node);
    if (node["community"] !== null && node["community"] !== undefined) communities.add(node["community"]);
    const sourceFile = node["source_file"];
    if (typeof sourceFile === "string" && sourceFile) files.add(sourceFile);
  }

  const confidence: GraphConfidenceTally = { extracted: 0, inferred: 0, ambiguous: 0 };
  const degree = new Map<string, number>();
  const bump = (id: unknown) => {
    if (typeof id !== "string") return;
    degree.set(id, (degree.get(id) ?? 0) + 1);
  };
  for (const link of links) {
    const conf = link["confidence"];
    if (conf === "EXTRACTED" || conf === undefined) confidence.extracted += 1;
    else if (conf === "INFERRED") confidence.inferred += 1;
    else confidence.ambiguous += 1; // AMBIGUOUS, or anything unrecognized — needs a closer look either way
    bump(link["source"]);
    bump(link["target"]);
  }

  const topNodes: GraphTopNode[] = [...degree.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_NODES_LIMIT)
    .map(([id, deg]) => {
      const node = nodeById.get(id);
      const label = typeof node?.["label"] === "string" ? (node["label"] as string) : id;
      const sourceFile = typeof node?.["source_file"] === "string" ? (node["source_file"] as string) : undefined;
      return { label, degree: deg, ...(sourceFile ? { sourceFile } : {}) };
    });

  return {
    available: true,
    repoPath: objective.repoPath,
    graphPath,
    nodeCount: nodes.length,
    edgeCount: links.length,
    communityCount: communities.size,
    fileCount: files.size,
    confidence,
    topNodes,
    builtAt: statSync(graphPath).mtimeMs,
  };
}

/* ------------------------------------------------------------------ *
 * Activity — a global, cross-objective feed. Everything the per-objective
 * event log already shows, just not scoped to one objective — this is what
 * makes "who did what, and where" answerable from the front page instead of
 * requiring a click into every objective in turn.
 * ------------------------------------------------------------------ */

export interface ActivityItem {
  id: number;
  ts: number;
  level: string;
  type: string;
  kind: string;
  text: string;
  model: string | null;
  objectiveId: string | null;
  objectiveTitle: string | null;
  taskId: string | null;
  runId: string | null;
}

export function listActivity(db: Db, limit = 80): ActivityItem[] {
  const rows = db.select().from(events).orderBy(desc(events.id)).limit(limit).all();
  const objRows = db.select({ id: objectives.id, title: objectives.title }).from(objectives).all();
  const titleById = new Map(objRows.map((o) => [o.id, o.title] as const));

  return rows.map((row) => {
    const display = describeEvent(row.payload);
    return {
      id: row.id,
      ts: row.ts,
      level: row.level,
      type: row.type,
      kind: display.kind,
      text: display.text,
      model: extractModel(row.payload),
      objectiveId: row.objectiveId,
      objectiveTitle: row.objectiveId ? (titleById.get(row.objectiveId) ?? null) : null,
      taskId: row.taskId,
      runId: row.runId,
    };
  });
}
