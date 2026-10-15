import type { Session } from '@supabase/supabase-js';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { disablePush } from '@/lib/notifications';
import { signInErrorMessage } from './account';
import { keychainStorage } from '@/lib/keychain-storage';
import { AUTH_STORAGE_KEY, supabase } from '@/lib/supabase';
import { withTimeout } from './timeout';

interface AuthState {
  /** `undefined` while the stored session is still being read. */
  session: Session | null | undefined;
}

const AuthContext = createContext<AuthState>({ session: undefined });

/** Set by the provider: shows the signed-out app even when Supabase can't
 *  confirm the sign-out (offline), after the stored session is cleared. */
let showSignedOut: (() => void) | undefined;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    showSignedOut = () => setSession(null);
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => {
      showSignedOut = undefined;
      data.subscription.unsubscribe();
    };
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
      // Email too, so the account has one to show (and Supabase never has to
      // accept an email-less sign-in). "Hide My Email" still works.
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
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
    if (error) return { ok: false, cancelled: false, message: signInErrorMessage(error.message, 'Apple') };

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
    const detail = [code, err instanceof Error ? err.message : ''].filter(Boolean).join(': ').slice(0, 120);
    return {
      ok: false,
      cancelled: false,
      message: `Sign in with Apple isn’t available right now.${detail ? `\n\n(${detail})` : ''}`,
    };
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
  if (exchange.error) return { ok: false, cancelled: false, message: signInErrorMessage(exchange.error.message, 'Google') };
  return { ok: true };
}

/**
 * Signs out — always. Notifications to this phone are switched off first
 * (best effort, time-boxed), then the session is ended on the server too.
 * If the server can't be reached, this phone is signed out anyway: the
 * stored session is cleared from the Keychain, so pressing Sign Out can
 * never leave someone signed in.
 */
export async function signOut(): Promise<void> {
  await disablePush();
  try {
    const { error } = await withTimeout(supabase.auth.signOut(), 6000, 'sign-out');
    if (!error) return;
  } catch {
    // Fall through to signing out locally.
  }
  supabase.auth.stopAutoRefresh();
  await keychainStorage.removeItem(AUTH_STORAGE_KEY).catch(() => {});
  await keychainStorage.removeItem(`${AUTH_STORAGE_KEY}-code-verifier`).catch(() => {});
  showSignedOut?.();
}
