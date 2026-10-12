/**
 * The numbers behind the Insights screen. Pure, so totals are tested apart
 * from any drawing — a chart that's pretty but wrong is worse than none.
 */

export interface RunCost {
  started_at: number;
  cost_usd: number;
  model: string;
}

export interface DaySpend {
  /** Local calendar day, YYYY-MM-DD. */
  key: string;
  /** Midnight of that day, local time, epoch ms. */
  start: number;
  cost: number;
}

function localMidnight(ms: number): Date {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dayKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** One entry per local day for the last `days` days, today last, with days
 *  that had no runs present as zero — a gap is information, not missing data. */
export function dailySpend(runs: RunCost[], now: number, days = 30): DaySpend[] {
  const buckets: DaySpend[] = [];
  const today = localMidnight(now);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    buckets.push({ key: dayKey(d), start: d.getTime(), cost: 0 });
  }
  const index = new Map(buckets.map((b, i) => [b.key, i] as const));
  for (const r of runs) {
    const i = index.get(dayKey(localMidnight(r.started_at)));
    if (i !== undefined) buckets[i]!.cost += r.cost_usd;
  }
  return buckets;
}

export interface ModelSpend {
  model: string;
  cost: number;
  runs: number;
}

/** Spend per model, largest first. */
export function spendByModel(runs: RunCost[]): ModelSpend[] {
  const by = new Map<string, ModelSpend>();
  for (const r of runs) {
    const m = by.get(r.model) ?? { model: r.model, cost: 0, runs: 0 };
    m.cost += r.cost_usd;
    m.runs += 1;
    by.set(r.model, m);
  }
  return [...by.values()].sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model));
}

export function peakDay(days: DaySpend[]): DaySpend | undefined {
  return days.reduce<DaySpend | undefined>((best, d) => (d.cost > 0 && (!best || d.cost > best.cost) ? d : best), undefined);
}

/** A percentage for display, or an em dash when there's no data — never a
 *  misleading 0% or 100%. */
export function pct(value: number | undefined | null): string {
  return value === undefined || value === null || Number.isNaN(value) ? '—' : `${Math.round(value)}%`;
}
