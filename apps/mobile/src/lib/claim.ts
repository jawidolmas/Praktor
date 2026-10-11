/**
 * The PC shows `praktor-claim:v1:<64 hex chars>` as a QR code.
 *
 * Deliberately *not* a URL: a link could be sent to you by anyone (a
 * website, a message) and opened with one tap, and claiming someone else's
 * computer would let it read your Praktor data. A bare code is only ever
 * accepted from the in-app scanner, which you open on purpose, pointed at a
 * screen in front of you.
 */

const PREFIX = 'praktor-claim:v1:';
const CODE = /^[0-9a-f]{64}$/;

export function parseClaimCode(scanned: string): string | undefined {
  const value = scanned.trim();
  if (!value.startsWith(PREFIX)) return undefined;
  const code = value.slice(PREFIX.length);
  return CODE.test(code) ? code : undefined;
}

/** Turns the relay's error into something a person can act on. */
export function claimErrorMessage(message: string): string {
  if (/invalid or expired/i.test(message)) {
    return 'That code has expired or was already used. Run "exec-agent cloud connect" on your computer for a new one.';
  }
  if (/cannot claim itself/i.test(message)) return 'This code belongs to this account already.';
  if (/sign in/i.test(message)) return 'Sign in again, then scan the code.';
  return 'Couldn’t add the computer. Check your connection and try again.';
}
