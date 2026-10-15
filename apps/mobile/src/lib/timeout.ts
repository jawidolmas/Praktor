/** Settles with `promise`, or rejects once `ms` passes — for calls that
 *  iOS or the network may never answer, where waiting forever would freeze
 *  something the person is waiting on (like signing out). */
export function withTimeout<T>(promise: Promise<T>, ms: number, what = 'operation'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
