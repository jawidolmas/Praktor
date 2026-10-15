import { describe, expect, it } from 'vitest';

import { accountLabel, signInErrorMessage } from './account';

describe('accountLabel', () => {
  it('says Google, not Apple, for a Google sign-in — and shows the email', () => {
    const l = accountLabel({
      email: 'jawid@example.com',
      app_metadata: { provider: 'google' },
      user_metadata: { full_name: 'Jawid Olmas' },
    });
    expect(l).toEqual({ title: 'Jawid Olmas', subtitle: 'Signed in with Google · jawid@example.com', symbol: 'g.circle.fill' });
  });

  it('uses the email as the title when there is no name', () => {
    expect(accountLabel({ email: 'a@b.co', app_metadata: { provider: 'apple' }, user_metadata: {} })).toEqual({
      title: 'a@b.co',
      subtitle: 'Signed in with Apple',
      symbol: 'apple.logo',
    });
  });

  it('builds a name from given and family names (what Apple sends)', () => {
    expect(accountLabel({ app_metadata: { provider: 'apple' }, user_metadata: { given_name: 'Jawid', family_name: 'Olmas' } }).title).toBe(
      'Jawid Olmas',
    );
  });

  it('never claims a provider it does not know', () => {
    expect(accountLabel(null)).toEqual({ title: 'Your account', subtitle: 'Signed in', symbol: 'person.fill' });
  });
});

describe('signInErrorMessage', () => {
  it('explains the misconfigured Apple client id case and keeps the raw detail', () => {
    const m = signInErrorMessage('Unacceptable audience in id_token: [com.olmassystems.praktor]', 'Apple');
    expect(m).toMatch(/isn’t set up for this app yet/);
    expect(m).toContain('Unacceptable audience');
  });

  it('explains a missing email', () => {
    expect(signInErrorMessage('Error getting user email from external provider', 'Apple')).toMatch(/didn’t share an email/);
  });

  it('keeps network trouble simple', () => {
    expect(signInErrorMessage('TypeError: Network request failed', 'Google')).toBe(
      'Couldn’t reach Praktor. Check your connection and try again.',
    );
  });

  it('falls back to a plain message with the detail attached', () => {
    expect(signInErrorMessage('something odd', 'Apple')).toBe('Couldn’t sign in.\n\n(something odd)');
  });
});
