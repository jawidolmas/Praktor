import { describe, expect, it } from 'vitest';

import { withTimeout } from './timeout';

describe('withTimeout', () => {
  it('passes a prompt result through', async () => {
    await expect(withTimeout(Promise.resolve(42), 100)).resolves.toBe(42);
  });

  it('gives up on a promise that never settles', async () => {
    await expect(withTimeout(new Promise(() => {}), 20, 'push token')).rejects.toThrow(/push token timed out/);
  });

  it('passes a prompt failure through unchanged', async () => {
    await expect(withTimeout(Promise.reject(new Error('nope')), 100)).rejects.toThrow('nope');
  });
});
