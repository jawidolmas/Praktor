import * as Crypto from 'expo-crypto';

/**
 * supabase-js protects OAuth sign-in with PKCE, using Web Crypto when it
 * exists. Hermes has no Web Crypto, and without it supabase-js silently
 * degrades twice: the PKCE verifier comes from Math.random() (predictable),
 * and the challenge is sent "plain" instead of SHA-256 hashed.
 *
 * This backs exactly the two calls it needs with iOS's own crypto
 * (expo-crypto → SecRandomCopyBytes / CommonCrypto), so sign-in gets a
 * CSPRNG verifier and an S256 challenge. Imported before supabase-js.
 */

type Digestible = ArrayBuffer | ArrayBufferView;

const g = globalThis as unknown as { crypto?: Record<string, unknown> };
g.crypto ??= {};

if (typeof g.crypto.getRandomValues !== 'function') {
  g.crypto.getRandomValues = <T extends ArrayBufferView>(array: T): T =>
    Crypto.getRandomValues(array as unknown as Uint8Array) as unknown as T;
}

if (typeof g.crypto.subtle !== 'object' || g.crypto.subtle === null) {
  g.crypto.subtle = {
    digest(algorithm: string | { name: string }, data: Digestible): Promise<ArrayBuffer> {
      const name = (typeof algorithm === 'string' ? algorithm : algorithm.name).toUpperCase();
      if (name !== 'SHA-256') return Promise.reject(new Error(`digest: ${name} is not supported`));
      return Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, data as BufferSource);
    },
  };
}
