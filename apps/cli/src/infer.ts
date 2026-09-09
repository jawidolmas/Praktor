import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AcceptanceCheck } from "@exec/core";

/**
 * Infer an acceptance check from a plain-English request, for the `do` command.
 *
 * This is a small heuristic, not a brain call — the LLM-backed `decompose` call
 * site from the plan would do this properly. Until that exists, "add/create
 * <file>" gets a real, specific check (the file exists and is non-empty); anything
 * else falls back to a weak generic one (the repo moved somehow — dirty working
 * tree, or new commits past the attempt's base, so a "commit and push" request
 * that correctly leaves a clean tree still counts). The fallback is intentionally
 * not disguised as a real check — the caller is expected to surface
 * `specific: false` to the user and suggest `--check`.
 *
 * Both checks shell out to a bundled Node script rather than POSIX `test`/`grep`
 * — those depend on external coreutils being on PATH, which holds in a Git Bash
 * shell but not in a bare Windows PowerShell/cmd.exe session (confirmed: this
 * silently broke acceptance checks there). `node <script>` has no such
 * dependency, since Node is guaranteed to be on PATH for exec-agent to run at all.
 */

const FILE_MENTION = /\b(?:add|create|write|make)\b[^.]*?\b([\w./-]+\.[a-zA-Z0-9]{1,8})\b/i;

const binDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin");
const checkExistsScript = join(binDir, "check-exists.mjs");
const checkRepoChangedScript = join(binDir, "check-repo-changed.mjs");

export interface InferredCheck {
  check: AcceptanceCheck;
  specific: boolean;
  /** Set when the requested file already exists in the repo — on a
   *  case-insensitive filesystem (Windows, default macOS) that includes a
   *  same-name-different-case match. A worker that reasonably avoids clobbering
   *  it may write somewhere else, which this fixed-path check cannot follow. */
  collisionWarning?: string;
}

export function inferCheck(text: string, repoPath?: string): InferredCheck {
  const fileMatch = FILE_MENTION.exec(text)?.[1];
  if (fileMatch) {
    const check: AcceptanceCheck = {
      label: `${fileMatch} exists`,
      command: `node "${checkExistsScript}" "${fileMatch}"`,
      expectExitCode: 0,
      timeoutMs: 10_000,
    };
    const collides = repoPath !== undefined && existsSync(join(repoPath, fileMatch));
    return {
      specific: true,
      check,
      ...(collides
        ? {
            collisionWarning:
              `"${fileMatch}" (or a same name in a different case) already exists in this repo. ` +
              `On a case-insensitive filesystem the worker may avoid overwriting it and write ` +
              `somewhere else instead — this check is fixed to the literal path and won't follow that.`,
          }
        : {}),
    };
  }

  return {
    specific: false,
    check: {
      label: "something changed",
      command: `node "${checkRepoChangedScript}"`,
      expectExitCode: 0,
      timeoutMs: 10_000,
    },
  };
}
