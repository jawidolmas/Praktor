import { eq, or } from "drizzle-orm";
import { isEvent } from "@exec/core";
import type { Db } from "./client.js";
import { events, runs } from "./schema.js";

/* ------------------------------------------------------------------ *
 * Cost & model attribution — shared by the dashboard and the cloud sync
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
