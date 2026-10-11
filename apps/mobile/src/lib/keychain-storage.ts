import * as SecureStore from 'expo-secure-store';

/**
 * Supabase session storage that never leaves the iOS Keychain.
 *
 * A session (access + refresh token) is larger than the ~2 KB some iOS
 * releases accept per Keychain item, so it's split across numbered items.
 * Supabase's own sample instead keeps the session in AsyncStorage under
 * AES-CTR — unauthenticated encryption next to plain app storage. Chunking
 * keeps every byte in the Keychain instead.
 *
 * AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: readable in the background (so token
 * refresh works while the phone is locked), and excluded from backups that
 * restore onto a different device.
 */

const CHUNK = 1800;
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/** Keychain keys allow only [A-Za-z0-9._-]. Supabase's storage keys contain
 *  other characters, so map them onto a safe alphabet. */
function safeKey(key: string): string {
  return `praktor.${key.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

async function readCount(base: string): Promise<number> {
  const raw = await SecureStore.getItemAsync(`${base}.n`, OPTIONS);
  const n = raw === null ? 0 : Number(raw);
  return Number.isInteger(n) && n > 0 && n < 100 ? n : 0;
}

async function removeChunks(base: string, from: number, to: number): Promise<void> {
  for (let i = from; i < to; i++) await SecureStore.deleteItemAsync(`${base}.${i}`, OPTIONS);
}

export const keychainStorage = {
  async getItem(key: string): Promise<string | null> {
    const base = safeKey(key);
    const n = await readCount(base);
    if (n === 0) return null;
    const parts: string[] = [];
    for (let i = 0; i < n; i++) {
      const part = await SecureStore.getItemAsync(`${base}.${i}`, OPTIONS);
      // A missing chunk means a half-written session: treat it as signed out
      // rather than handing Supabase corrupted JSON.
      if (part === null) return null;
      parts.push(part);
    }
    return parts.join('');
  },

  async setItem(key: string, value: string): Promise<void> {
    const base = safeKey(key);
    const previous = await readCount(base);
    const n = Math.max(1, Math.ceil(value.length / CHUNK));
    for (let i = 0; i < n; i++) {
      await SecureStore.setItemAsync(`${base}.${i}`, value.slice(i * CHUNK, (i + 1) * CHUNK), OPTIONS);
    }
    // The count is written last. A crash mid-write can leave old and new
    // chunks mixed; that fails to parse as a session, which Supabase treats
    // as signed out — the safe outcome, never a wrong identity.
    await SecureStore.setItemAsync(`${base}.n`, String(n), OPTIONS);
    if (previous > n) await removeChunks(base, n, previous);
  },

  async removeItem(key: string): Promise<void> {
    const base = safeKey(key);
    const n = await readCount(base);
    await SecureStore.deleteItemAsync(`${base}.n`, OPTIONS);
    await removeChunks(base, 0, n);
  },
};
