/** Only routes this app actually has, with a well-formed id — a
 *  notification's payload is never trusted to navigate anywhere else. */
export function safeRoute(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  return /^\/(decisions|objectives)\/[A-Za-z0-9_-]{1,64}$/.test(url) ? url : undefined;
}
