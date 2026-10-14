/** Conversation-list helpers, pure so they're tested apart from the UI. */

export type DayGroup = 'Today' | 'Yesterday' | 'Previous 7 Days' | 'Previous 30 Days' | 'Older';

const ORDER: DayGroup[] = ['Today', 'Yesterday', 'Previous 7 Days', 'Previous 30 Days', 'Older'];

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dayGroup(at: number, now: number): DayGroup {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days <= 7) return 'Previous 7 Days';
  if (days <= 30) return 'Previous 30 Days';
  return 'Older';
}

/** Groups items (already newest first) the way the Claude app's history
 *  does, keeping only groups that have something in them. */
export function groupByDay<T>(items: T[], at: (item: T) => number, now: number): { title: DayGroup; items: T[] }[] {
  const groups = new Map<DayGroup, T[]>();
  for (const item of items) {
    const g = dayGroup(at(item), now);
    groups.set(g, [...(groups.get(g) ?? []), item]);
  }
  return ORDER.filter((g) => groups.has(g)).map((title) => ({ title, items: groups.get(title)! }));
}

export const MAX_MESSAGE = 4000;
