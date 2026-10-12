/**
 * The independent judge occasionally fails outright — an API hiccup, or a
 * session that ends without ever calling submit_review (seen live). Before
 * giving up on a verdict, try again: these failures are usually transient.
 *
 * Giving up is still never a reason to wedge an unattended objective, but it
 * is no longer silent either: the caller records the work as *unreviewed*,
 * which the dashboard and the phone show before anyone merges it.
 */

export const REVIEW_ATTEMPTS = 3;

export type ReviewTry<T> =
  | { ok: true; value: T; failures: string[] }
  | { ok: false; failures: string[] };

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function reviewWithRetry<T>(
  run: () => Promise<T>,
  options: { attempts?: number; pauseMs?: (attempt: number) => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ReviewTry<T>> {
  const attempts = options.attempts ?? REVIEW_ATTEMPTS;
  const pauseMs = options.pauseMs ?? ((n) => n * 5_000);
  const sleep = options.sleep ?? ((ms) => new Promise<void>((res) => setTimeout(res, ms)));
  const failures: string[] = [];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return { ok: true, value: await run(), failures };
    } catch (err) {
      failures.push(describe(err));
      if (attempt < attempts) await sleep(pauseMs(attempt));
    }
  }
  return { ok: false, failures };
}
