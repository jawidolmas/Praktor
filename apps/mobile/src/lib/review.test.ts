import { describe, expect, it } from 'vitest';

import type { ActivityEvent } from './relay';
import { reviewState } from './review';

let next = 1;
function ev(task: string, type: string, kind: ActivityEvent['kind'], ts: number): ActivityEvent {
  return { id: next++, host_id: 'h', task_id: task, ts, type, kind, text: type, model: null };
}

describe('reviewState', () => {
  it('flags a task whose latest review produced no verdict', () => {
    const s = reviewState([ev('t1', 'review.unavailable', 'warn', 10)]);
    expect(s.unreviewed).toHaveLength(1);
    expect(s.verdicts).toHaveLength(0);
  });

  it('counts a task as reviewed when a retry succeeded after a failure', () => {
    const s = reviewState([ev('t1', 'review.unavailable', 'warn', 10), ev('t1', 'review.result', 'success', 20)]);
    expect(s.unreviewed).toHaveLength(0);
    expect(s.verdicts).toHaveLength(1);
  });

  it('judges each task on its own latest review', () => {
    const s = reviewState([
      ev('t1', 'review.result', 'success', 10),
      ev('t2', 'review.result', 'success', 11),
      ev('t2', 'review.unavailable', 'warn', 30),
    ]);
    expect(s.verdicts.map((e) => e.task_id)).toEqual(['t1']);
    expect(s.unreviewed.map((e) => e.task_id)).toEqual(['t2']);
  });

  it('ignores unrelated events', () => {
    expect(reviewState([ev('t1', 'run.finished', 'info', 1)])).toEqual({ verdicts: [], unreviewed: [] });
  });
});
