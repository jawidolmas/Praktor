import { desc, eq } from "drizzle-orm";
import {
  acceptedRuns,
  answerDecision,
  appendEvent,
  AUTOSTART_MODE_EXPLANATIONS,
  autostartStatus,
  decisions,
  findRunningDaemon,
  listObjectives,
  markObjectiveMerged,
  objectives,
  policies,
  readEvents,
  runs,
  tasks,
  type AutostartMode,
  type AutostartStatus,
  type Db,
} from "@exec/db";
import { attemptBranchName, computeApprovalDiffs, mergeAndPushAll } from "@exec/worker";
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

export function listPolicies(db: Db) {
  return db.select().from(policies).orderBy(policies.key).all();
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

  return { ok: result.allMerged, message: result.message };
}
