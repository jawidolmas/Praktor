import type { ActivityEvent } from '@/lib/relay';

/**
 * What the independent judge concluded about each task, from the activity
 * log: the *latest* review event per task wins, so a review that failed and
 * then succeeded on retry counts as reviewed, and one that never produced a
 * verdict is reported as exactly that — never as accepted.
 */
export interface ReviewState {
  /** Latest accepted verdicts, one per task. */
  verdicts: ActivityEvent[];
  /** Tasks whose latest review produced no verdict at all. */
  unreviewed: ActivityEvent[];
}

export function reviewState(events: ActivityEvent[]): ReviewState {
  const latest = new Map<string, ActivityEvent>();
  // Newest first, as fetched; keep the first review event seen per task.
  const newestFirst = [...events].sort((a, b) => b.ts - a.ts || b.id - a.id);
  for (const e of newestFirst) {
    if (e.type !== 'review.result' && e.type !== 'review.unavailable') continue;
    const task = e.task_id ?? '';
    if (!latest.has(task)) latest.set(task, e);
  }
  const all = [...latest.values()];
  return {
    verdicts: all.filter((e) => e.type === 'review.result' && e.kind === 'success'),
    unreviewed: all.filter((e) => e.type === 'review.unavailable'),
  };
}
