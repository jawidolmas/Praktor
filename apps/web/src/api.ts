import { desc, eq } from "drizzle-orm";
import {
  acceptedRun,
  answerDecision,
  appendEvent,
  decisions,
  events,
  markObjectiveMerged,
  objectives,
  policies,
  readEvents,
  runs,
  tasks,
  type Db,
} from "@exec/db";
import { attemptBranchName, computeApprovalDiff, mergeAndPush } from "@exec/worker";
import { describeEvent } from "./format.js";

/**
 * Data access for the dashboard. Almost every function here only ever
 * selects — the daemon is the sole process actually driving work, and
 * SQLite's WAL mode is what lets this read concurrently with it without
 * blocking it. `answerOpenDecision` is the one write: answering a decision
 * is safe for any process to do (the daemon only polls for the answer, it
 * doesn't own the decision), which is exactly what makes it possible to
 * answer one from here instead of only from the terminal that submitted it.
 */

export interface ObjectiveSummary {
  id: string;
  title: string;
  status: string;
  repoPath: string;
  createdAt: number;
  updatedAt: number;
  taskCount: number;
  doneTaskCount: number;
  lastEventAt: number | null;
}

export function listObjectives(db: Db): ObjectiveSummary[] {
  const objRows = db.select().from(objectives).orderBy(desc(objectives.createdAt)).all();
  const taskRows = db.select().from(tasks).all();
  const lastEventRows = db
    .select({ objectiveId: events.objectiveId, ts: events.ts })
    .from(events)
    .all();

  const lastEventByObjective = new Map<string, number>();
  for (const row of lastEventRows) {
    if (!row.objectiveId) continue;
    const prev = lastEventByObjective.get(row.objectiveId) ?? 0;
    if (row.ts > prev) lastEventByObjective.set(row.objectiveId, row.ts);
  }

  return objRows.map((o) => {
    const forObjective = taskRows.filter((t) => t.objectiveId === o.id);
    return {
      id: o.id,
      title: o.title,
      status: o.status,
      repoPath: o.repoPath,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
      taskCount: forObjective.length,
      doneTaskCount: forObjective.filter((t) => t.status === "done").length,
      lastEventAt: lastEventByObjective.get(o.id) ?? null,
    };
  });
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

export interface ApprovalStatus {
  /** True only when there's a real diff sitting there, unmerged, ready for a
   *  human "yes" — the one case the dashboard shows a diff and a button for. */
  eligible: boolean;
  alreadyMerged: boolean;
  mergedAt?: number;
  reason?: string;
  branch?: string;
  repoPath?: string;
  diff?: string;
}

/** What the "Review & Approve" panel needs: the diff to show, or a plain
 *  reason there's nothing to approve yet (not done, no actual change) — or,
 *  distinctly, confirmation that it's already been merged. Computing the
 *  diff means running git against the user's real repo — read-only
 *  (`git diff`), same trust level as everything else here, just pointed at
 *  a different path than a worktree. */
export function getApprovalStatus(db: Db, objectiveId: string): ApprovalStatus {
  const objective = db.select().from(objectives).where(eq(objectives.id, objectiveId)).get();
  if (!objective) return { eligible: false, alreadyMerged: false, reason: "No such objective." };
  if (objective.mergedAt) {
    return { eligible: false, alreadyMerged: true, mergedAt: objective.mergedAt };
  }

  const accepted = acceptedRun(db, objectiveId);
  if (!accepted) {
    return {
      eligible: false,
      alreadyMerged: false,
      reason: objective.status === "done" ? "No accepted run was found." : `Not done yet (status: ${objective.status}).`,
    };
  }

  const branch = attemptBranchName(accepted.taskId, accepted.attempt);
  const diff = computeApprovalDiff({ repoPath: accepted.repoPath, baseRef: accepted.baseRef, branch });
  if (!diff.trim()) {
    return { eligible: false, alreadyMerged: false, reason: "The accepted branch has nothing beyond its base — nothing to approve." };
  }

  return { eligible: true, alreadyMerged: false, branch, repoPath: accepted.repoPath, diff };
}

export interface ApproveResult {
  ok: boolean;
  message: string;
}

/** Merge and push the accepted branch into the real repo, gated on the
 *  dashboard's Merge button having just been clicked — that click is the
 *  human "yes" this operation requires, the same as the CLI's y/N prompt. */
export function approveObjective(db: Db, objectiveId: string, approvedBy: string): ApproveResult {
  const objective = db.select().from(objectives).where(eq(objectives.id, objectiveId)).get();
  if (!objective) return { ok: false, message: "No such objective." };
  if (objective.mergedAt) return { ok: false, message: "Already merged." };

  const accepted = acceptedRun(db, objectiveId);
  if (!accepted) return { ok: false, message: "Nothing to approve." };

  const branch = attemptBranchName(accepted.taskId, accepted.attempt);
  const result = mergeAndPush({ repoPath: accepted.repoPath, baseRef: accepted.baseRef, branch });

  if (result.merged) {
    markObjectiveMerged(db, objectiveId);
    appendEvent(db, {
      objectiveId,
      payload: {
        type: "objective.approved",
        branch,
        baseRef: result.baseBranch,
        pushed: result.pushed,
        approvedBy,
      },
    });
  }

  return { ok: result.merged, message: result.message };
}
