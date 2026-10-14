import { describe, expect, it } from 'vitest';

import { dayGroup, groupByDay } from './chat';

const NOW = new Date(2026, 9, 14, 15, 0).getTime();
const at = (month: number, day: number, hour = 12) => new Date(2026, month, day, hour).getTime();

describe('dayGroup', () => {
  it('buckets by calendar day, not 24-hour windows', () => {
    expect(dayGroup(at(9, 14, 0), NOW)).toBe('Today');
    expect(dayGroup(at(9, 13, 23), NOW)).toBe('Yesterday');
    expect(dayGroup(at(9, 7), NOW)).toBe('Previous 7 Days');
    expect(dayGroup(at(8, 20), NOW)).toBe('Previous 30 Days');
    expect(dayGroup(at(5, 1), NOW)).toBe('Older');
  });
});

describe('groupByDay', () => {
  it('keeps newest-first order inside groups and drops empty groups', () => {
    const items = [at(9, 14, 10), at(9, 14, 9), at(9, 12), at(5, 1)];
    const groups = groupByDay(items, (x) => x, NOW);
    expect(groups.map((g) => g.title)).toEqual(['Today', 'Previous 7 Days', 'Older']);
    expect(groups[0]!.items).toEqual([at(9, 14, 10), at(9, 14, 9)]);
  });
});
