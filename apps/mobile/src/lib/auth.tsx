import type { Session } from '@supabase/supabase-js';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { supabase } from '@/lib/supabase';

interface AuthState {
  /** `undefined` while the stored session is still being read. */
  session: Session | null | undefined;
}

const AuthContext = createContext<AuthState>({ session: undefined });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  const value = useMemo(() => ({ session }), [session]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useSession(): Session | null | undefined {
  return useContext(AuthContext).session;
}

export type SignInResult = { ok: true } | { ok: false; cancelled: boolean; message: string };

/**
 * Sign in with Apple, then exchange Apple's identity token for a Supabase
 * session. A fresh nonce binds the token to this one request: Apple embeds
 * its SHA-256 in the token, and Supabase checks it against the raw value,
 * so a token lifted from elsewhere can't be replayed here.
 */
export async function signInWithApple(): Promise<SignInResult> {
  const rawNonce = Crypto.randomUUID() + Crypto.randomUUID();
  const hashedNonce = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce);

  try {
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME],
      nonce: hashedNonce,
    });
    if (!credential.identityToken) {
      return { ok: false, cancelled: false, message: 'Apple didn’t return a sign-in token. Please try again.' };
    }

    const { error } = await supabase.auth.signInWithIdToken({
      provider: 'apple',
      token: credential.identityToken,
      nonce: rawNonce,
    });
    if (error) return { ok: false, cancelled: false, message: 'Couldn’t sign in. Check your connection and try again.' };

    // Apple shares the name only on the very first sign-in; keep it.
    const given = credential.fullName?.givenName;
    if (given) {
      await supabase.auth.updateUser({
        data: { given_name: given, family_name: credential.fullName?.familyName ?? null },
      });
    }
    return { ok: true };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ERR_REQUEST_CANCELED') return { ok: false, cancelled: true, message: '' };
    return { ok: false, cancelled: false, message: 'Sign in with Apple isn’t available right now.' };
  }
}

/**
 * Where sign-in returns to — the only entry on the Supabase project's
 * Redirect URLs allow-list. The sign-in sheet (ASWebAuthenticationSession)
 * catches this address itself, so it works the same in Expo Go as in the
 * real app, without iOS routing the link to anyone. Supabase matches it
 * exactly: no wildcard, nothing else can be substituted for it.
 */
export const AUTH_REDIRECT = 'praktor://auth-callback';

/** Reads one query parameter. Hand-rolled because React Native's URL
 *  implementation doesn't fully support searchParams. */
export function queryParam(url: string, name: string): string | undefined {
  const match = new RegExp(`[?&]${name}=([^&#]*)`).exec(url);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]!.replace(/\+/g, ' '));
  } catch {
    return undefined;
  }
}

/**
 * Sign in with Google through Supabase, inside Apple's secure sign-in sheet
 * (ASWebAuthenticationSession): the page runs in Safari's context, never in
 * a web view this app could read, and the callback returns straight to this
 * app rather than through iOS's shared URL routing. PKCE (S256, see
 * crypto-shim) binds the returned code to this device.
 */
export async function signInWithGoogle(): Promise<SignInResult> {
  const redirectTo = AUTH_REDIRECT;
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, skipBrowserRedirect: true, queryParams: { prompt: 'select_account' } },
  });
  if (error || !data.url) return { ok: false, cancelled: false, message: 'Google sign-in isn’t available right now.' };

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo, { preferEphemeralSession: true });
  if (result.type !== 'success') return { ok: false, cancelled: true, message: '' };

  const code = queryParam(result.url, 'code');
  if (!code) {
    const denied = queryParam(result.url, 'error') === 'access_denied';
    return { ok: false, cancelled: denied, message: denied ? '' : 'Google didn’t complete the sign-in. Please try again.' };
  }

  const exchange = await supabase.auth.exchangeCodeForSession(code);
  if (exchange.error) return { ok: false, cancelled: false, message: 'Couldn’t sign in. Check your connection and try again.' };
  return { ok: true };
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}
