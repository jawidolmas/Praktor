import { desc, eq } from "drizzle-orm";
import {
  decisions,
  events,
  objectives,
  policies,
  readEvents,
  runs,
  tasks,
  type Db,
} from "@exec/db";
import { describeEvent } from "./format.js";

/**
 * Read-only data access for the dashboard. Every function here only ever
 * selects — the CLI process is the sole writer (enforced by convention, not
 * by a DB permission, same as the "one objective at a time" design today),
 * and SQLite's WAL mode is exactly what lets this read concurrently with a
 * run in progress without blocking it.
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
