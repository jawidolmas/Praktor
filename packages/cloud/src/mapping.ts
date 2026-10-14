import { describeEvent, type EventPayload } from "@exec/core";
import type { DecisionRow, EventRow, ObjectiveRow, RunRow, TaskRow } from "@exec/db";
import type { TaskFiles } from "./agent-files.js";

/**
 * Local SQLite rows → relay rows. Pure, so what leaves this machine is
 * decided in one reviewable, unit-tested place.
 *
 * Sync level B: status, costs, decisions, readable one-line event summaries,
 * and changed file *paths*. No file contents, no diffs, no raw event
 * payloads, no absolute paths on this machine. Level C (diffs) is a planned
 * opt-in and must not creep in here by accident.
 */

export interface Stamp {
  owner_id: string;
  host_id: string;
}

/** Event types that never leave the machine: the worker's own narration
 *  and tool traffic can quote source code verbatim, and per-turn / per-tool
 *  policy events are high-volume noise on a phone. */
export const LOCAL_ONLY_EVENT_TYPES: ReadonlySet<string> = new Set([
  "run.message",
  "run.turn",
  "run.tool_result",
  "policy.evaluated",
]);

/** Truncates to `max` characters, marking the cut. Matches the relay's
 *  column CHECK limits so a long value is shortened, not rejected. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function clipOrNull(text: string | null | undefined, max: number): string | null {
  return text === null || text === undefined ? null : clip(text, max);
}

/** The repo's folder name only — "C:\Users\me\Desktop\praktor" → "praktor".
 *  The full path would reveal this machine's user and layout. */
export function repoName(repoPath: string): string {
  const parts = repoPath.split(/[\\/]+/).filter((p) => p.length > 0);
  return clip(parts[parts.length - 1] ?? "repo", 200);
}

export function toCloudObjective(o: ObjectiveRow, costUsd: number, stamp: Stamp, changedFiles: number | null = null) {
  return {
    ...stamp,
    id: o.id,
    title: clip(o.title, 500),
    repo_name: repoName(o.repoPath),
    status: o.status,
    model: o.model,
    effort: o.effort,
    cost_usd: costUsd,
    changed_files: changedFiles,
    merged_at: o.mergedAt,
    created_at: o.createdAt,
    updated_at: o.updatedAt,
  };
}

export function toCloudTask(t: TaskRow, stamp: Stamp) {
  return {
    ...stamp,
    id: t.id,
    objective_id: t.objectiveId,
    key: clip(t.key, 32),
    title: clip(t.title, 500),
    task_class: t.taskClass,
    status: t.status,
    attempts: t.attempts,
    max_attempts: t.maxAttempts,
    depends_on: t.dependsOn,
    model: t.model,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  };
}

export function toCloudRun(r: RunRow, stamp: Stamp) {
  return {
    ...stamp,
    id: r.id,
    task_id: r.taskId,
    objective_id: r.objectiveId,
    attempt: r.attempt,
    model: r.model,
    effort: r.effort,
    status: r.status,
    exit_reason: clipOrNull(r.exitReason, 64),
    turns: r.turns,
    cost_usd: r.costUsdEstimate,
    started_at: r.startedAt,
    ended_at: r.endedAt,
  };
}

export function toCloudDecision(d: DecisionRow, stamp: Stamp) {
  return {
    ...stamp,
    id: d.id,
    key: d.key,
    objective_id: d.objectiveId,
    task_id: d.taskId,
    level: d.level,
    title: clip(d.title, 500),
    context: clip(d.context, 8000),
    options: d.options,
    recommendation: clip(d.recommendation, 200),
    risk: clip(d.risk, 2000),
    status: d.status,
    answer: clipOrNull(d.answer, 200),
    answered_by: clipOrNull(d.answeredBy, 200),
    answered_at: d.answeredAt,
    created_at: d.createdAt,
  };
}

function eventModel(payload: EventPayload): string | null {
  if (payload.type === "run.started") return payload.model;
  if (payload.type === "review.result" || payload.type === "diagnose.result" || payload.type === "brain.call") {
    return payload.model ?? null;
  }
  return null;
}

/** One readable line per event — the same text the dashboard shows — or
 *  undefined for event types that stay local. */
export function toCloudEvent(e: EventRow, stamp: Stamp) {
  if (LOCAL_ONLY_EVENT_TYPES.has(e.type)) return undefined;
  const display = describeEvent(e.payload);
  return {
    ...stamp,
    id: e.id,
    objective_id: e.objectiveId,
    task_id: e.taskId,
    ts: e.ts,
    level: e.level,
    type: e.type,
    kind: display.kind,
    text: clip(display.text, 2000),
    model: clipOrNull(eventModel(e.payload), 64),
  };
}

/** The relay's CHECK constraint on agent_files.change. */
const CHANGE_LETTERS: ReadonlySet<string> = new Set(["A", "M", "D", "R", "C", "T", "U", "X"]);

export function toCloudAgentFiles(objectiveId: string, files: TaskFiles, stamp: Stamp) {
  // Two changes can't share a path within one diff, but guard anyway: a
  // duplicate would fail the whole upsert on the primary key.
  const seen = new Set<string>();
  return files.changes
    .filter((c) => CHANGE_LETTERS.has(c.status) && c.path.length <= 1024 && !seen.has(c.path) && seen.add(c.path))
    .map((c) => ({
      ...stamp,
      task_id: files.taskId,
      path: c.path,
      objective_id: objectiveId,
      attempt: files.attempt,
      change: c.status,
      old_path: c.oldPath !== undefined && c.oldPath.length <= 1024 ? c.oldPath : null,
    }));
}
