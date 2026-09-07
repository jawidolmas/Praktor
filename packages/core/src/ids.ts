/**
 * Human-facing identifiers.
 *
 * Decisions and policies get stable, quotable keys (DEC-024, POLICY-003) because they are
 * referenced by people months later — in the decision log, in reports, and in the rationale
 * a worker is given. Internal rows keep opaque UUIDs; these keys are the public surface.
 */

const pad = (n: number, width = 3): string => String(n).padStart(width, "0");

export const decisionKey = (seq: number): string => `DEC-${pad(seq)}`;
export const policyKey = (seq: number): string => `POLICY-${pad(seq)}`;
export const taskKey = (seq: number): string => `T-${pad(seq)}`;

const KEY_PATTERN = /^(DEC|POLICY|T)-(\d{3,})$/;

/** Parse a human key back into its prefix and sequence, or null if it is not one. */
export function parseKey(key: string): { prefix: string; seq: number } | null {
  const m = KEY_PATTERN.exec(key);
  if (!m) return null;
  return { prefix: m[1]!, seq: Number(m[2]!) };
}

/** Session ids are UUIDs because the Claude Agent SDK requires that shape. */
export const newSessionId = (): string => crypto.randomUUID();
export const newId = (): string => crypto.randomUUID();
