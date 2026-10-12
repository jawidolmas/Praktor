import { describe, expect, it } from 'vitest';

import { dailySpend, peakDay, pct, spendByModel, type RunCost } from './insights';

const NOW = new Date(2026, 9, 12, 15, 0).getTime(); // 12 Oct 2026, 15:00 local
const at = (day: number, hour = 10) => new Date(2026, 9, day, hour).getTime();

describe('dailySpend', () => {
  it('buckets by local day, oldest first, today last, zero-filling quiet days', () => {
    const runs: RunCost[] = [
      { started_at: at(12, 9), cost_usd: 0.5, model: 'a' },
      { started_at: at(12, 14), cost_usd: 0.25, model: 'a' },
      { started_at: at(10), cost_usd: 1, model: 'b' },
    ];
    const days = dailySpend(runs, NOW, 3);
    expect(days.map((d) => [d.key, d.cost])).toEqual([
      ['2026-10-10', 1],
      ['2026-10-11', 0],
      ['2026-10-12', 0.75],
    ]);
  });

  it('ignores runs outside the window', () => {
    const days = dailySpend([{ started_at: at(1), cost_usd: 9, model: 'a' }], NOW, 7);
    expect(days.reduce((s, d) => s + d.cost, 0)).toBe(0);
    expect(days).toHaveLength(7);
  });

  it('crosses a month boundary', () => {
    const days = dailySpend([], new Date(2026, 9, 2, 12).getTime(), 4);
    expect(days.map((d) => d.key)).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  });
});

describe('spendByModel', () => {
  it('totals per model, largest first', () => {
    expect(
      spendByModel([
        { started_at: 0, cost_usd: 1, model: 'sonnet' },
        { started_at: 0, cost_usd: 3, model: 'opus' },
        { started_at: 0, cost_usd: 1, model: 'sonnet' },
      ]),
    ).toEqual([
      { model: 'opus', cost: 3, runs: 1 },
      { model: 'sonnet', cost: 2, runs: 2 },
    ]);
  });
});

describe('peakDay', () => {
  it('finds the most expensive day, or nothing when all are zero', () => {
    const days = dailySpend([{ started_at: at(11), cost_usd: 2, model: 'a' }], NOW, 3);
    expect(peakDay(days)?.key).toBe('2026-10-11');
    expect(peakDay(dailySpend([], NOW, 3))).toBeUndefined();
  });
});

describe('pct', () => {
  it('shows a dash for missing data, never a fake 0%', () => {
    expect(pct(undefined)).toBe('—');
    expect(pct(null)).toBe('—');
    expect(pct(87.4)).toBe('87%');
    expect(pct(0)).toBe('0%');
  });
});
