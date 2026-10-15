import { describe, expect, it, vi } from 'vitest';

// auth.tsx pulls in native modules; only the pure URL helper is under test.
vi.mock('expo-apple-authentication', () => ({}));
vi.mock('expo-crypto', () => ({}));
vi.mock('expo-web-browser', () => ({}));
vi.mock('@/lib/supabase', () => ({ supabase: {}, AUTH_STORAGE_KEY: 'k' }));
vi.mock('@/lib/keychain-storage', () => ({ keychainStorage: {} }));
vi.mock('@/lib/notifications', () => ({ disablePush: async () => {} }));

const { AUTH_REDIRECT, queryParam } = await import('./auth');

describe('queryParam', () => {
  it('reads the sign-in code from the return address', () => {
    expect(queryParam(`${AUTH_REDIRECT}?code=e3d9-46&state=x`, 'code')).toBe('e3d9-46');
    expect(queryParam(`${AUTH_REDIRECT}/?code=abc#`, 'code')).toBe('abc');
  });
  it('decodes values and reports absence', () => {
    expect(queryParam(`${AUTH_REDIRECT}?error=access_denied&error_description=a+b%21`, 'error_description')).toBe('a b!');
    expect(queryParam(`${AUTH_REDIRECT}?state=x`, 'code')).toBeUndefined();
    expect(queryParam(`${AUTH_REDIRECT}?xcode=1`, 'code')).toBeUndefined();
  });
});
