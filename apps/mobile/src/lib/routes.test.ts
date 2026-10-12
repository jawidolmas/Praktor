import { describe, expect, it } from 'vitest';

import { safeRoute } from './routes';

describe('safeRoute', () => {
  it('allows the two screens notifications open', () => {
    expect(safeRoute('/decisions/3f2a-9c')).toBe('/decisions/3f2a-9c');
    expect(safeRoute('/objectives/abc_123')).toBe('/objectives/abc_123');
  });

  it('rejects anything else a payload might carry', () => {
    for (const bad of [
      undefined,
      42,
      '',
      '/computers',
      '/decisions/',
      '/decisions/a/b',
      '/decisions/../sign-in',
      'https://evil.example/decisions/x',
      'praktor://decisions/x',
      '/decisions/x?redirect=https://evil.example',
      `/objectives/${'a'.repeat(65)}`,
    ]) {
      expect(safeRoute(bad)).toBeUndefined();
    }
  });
});
