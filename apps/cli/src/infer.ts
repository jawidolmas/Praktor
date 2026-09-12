import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AcceptanceCheck } from "@exec/core";
import { weakChangedCheck } from "@exec/worker";

/**
 * Infer an acceptance check from a plain-English request, for the `do` command
 * — the "do" command's routing layer, in effect: a cheap, deterministic,
 * zero-latency confidence check on whether the sentence is obviously a single
 * task, so a real planning brain call (`decompose`, in `@exec/worker`) is only
 * spent on sentences that actually need it. "add/create <file>" is confident
 * enough to get a real, specific check (the file exists and is non-empty) and
 * skip planning entirely; anything else returns `specific: false`, and the
 * caller routes it to `decompose` instead of guessing at a check for a
 * sentence this heuristic doesn't understand.
 *
 * The file-exists check shells out to a bundled Node script rather than POSIX
 * `test`/`grep` — those depend on external coreutils being on PATH, which
 * holds in a Git Bash shell but not in a bare Windows PowerShell/cmd.exe
 * session (confirmed: this silently broke acceptance checks there). `node
 * <script>` has no such dependency, since Node is guaranteed to be on PATH
 * for exec-agent to run at all.
 */

const FILE_MENTION = /\b(?:add|create|write|make)\b[^.]*?\b([\w./-]+\.[a-zA-Z0-9]{1,8})\b/i;

const checkExistsScript = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "bin",
  "check-exists.mjs",
);

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

  return { specific: false, check: weakChangedCheck() };
}
