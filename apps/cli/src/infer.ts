import type { AcceptanceCheck } from "@exec/core";

/**
 * Infer an acceptance check from a plain-English request, for the `do` command.
 *
 * This is a small heuristic, not a brain call — the LLM-backed `decompose` call
 * site from the plan would do this properly. Until that exists, "add/create
 * <file>" gets a real, specific check (the file exists and is non-empty); anything
 * else falls back to a weak generic one (something changed in the working tree).
 * The fallback is intentionally not disguised as a real check — the caller is
 * expected to surface `specific: false` to the user and suggest `--check`.
 */

const FILE_MENTION = /\b(?:add|create|write|make)\b[^.]*?\b([\w./-]+\.[a-zA-Z0-9]{1,8})\b/i;

export interface InferredCheck {
  check: AcceptanceCheck;
  specific: boolean;
}

export function inferCheck(text: string): InferredCheck {
  const fileMatch = FILE_MENTION.exec(text)?.[1];
  if (fileMatch) {
    return {
      specific: true,
      check: {
        label: `${fileMatch} exists`,
        command: `test -f "${fileMatch}" && test -s "${fileMatch}"`,
        expectExitCode: 0,
        timeoutMs: 10_000,
      },
    };
  }

  return {
    specific: false,
    check: {
      label: "something changed",
      command: "git status --porcelain | grep -q .",
      expectExitCode: 0,
      timeoutMs: 10_000,
    },
  };
}
