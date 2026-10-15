import type { SFSymbol } from 'expo-symbols';

/**
 * Small, pure helpers about the signed-in account and signing in — kept out
 * of the screens so they're tested on their own.
 */

export interface AccountUser {
  email?: string | null;
  app_metadata?: { provider?: string } | null;
  user_metadata?: Record<string, unknown> | null;
}

export interface AccountLabel {
  /** The person's name when known, else their email, else a neutral label. */
  title: string;
  /** How they signed in, plus the email when the title is their name. */
  subtitle: string;
  symbol: SFSymbol;
}

const PROVIDERS: Record<string, { name: string; symbol: SFSymbol }> = {
  apple: { name: 'Apple', symbol: 'apple.logo' },
  google: { name: 'Google', symbol: 'g.circle.fill' },
};

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function accountLabel(user: AccountUser | null | undefined): AccountLabel {
  const meta = user?.user_metadata ?? {};
  const provider = PROVIDERS[user?.app_metadata?.provider ?? ''];
  const email = text(user?.email);
  const name =
    text(meta.full_name) ??
    text(meta.name) ??
    ([text(meta.given_name), text(meta.family_name)].filter(Boolean).join(' ') || undefined);

  const via = provider ? `Signed in with ${provider.name}` : 'Signed in';
  return {
    title: name ?? email ?? 'Your account',
    subtitle: name && email ? `${via} · ${email}` : via,
    symbol: provider?.symbol ?? 'person.fill',
  };
}

/** Supabase's sign-in errors, in words a person can act on. The raw text
 *  stays attached at the end, so a screenshot is enough to diagnose it. */
export function signInErrorMessage(raw: string, provider: 'Apple' | 'Google'): string {
  const detail = raw.trim().slice(0, 120);
  const withDetail = (message: string) => (detail ? `${message}\n\n(${detail})` : message);
  if (/audience|client[ _-]?id/i.test(raw)) {
    return withDetail(`Sign in with ${provider} isn’t set up for this app yet. Try the other sign-in option for now.`);
  }
  if (/email/i.test(raw)) {
    return withDetail(
      `${provider} didn’t share an email address, which this sign-in needs. Try again and allow it — “Hide My Email” works too.`,
    );
  }
  if (/signups? not allowed|sign ?ups? (are )?disabled/i.test(raw)) {
    return withDetail('New Praktor accounts can’t be created right now.');
  }
  if (/nonce|expired/i.test(raw)) return withDetail('That sign-in expired. Please try again.');
  if (/network|fetch|timed? ?out|offline/i.test(raw)) return 'Couldn’t reach Praktor. Check your connection and try again.';
  return withDetail('Couldn’t sign in.');
}
