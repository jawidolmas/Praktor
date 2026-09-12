import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AcceptanceCheck } from "@exec/core";

/**
 * The weakest acceptance check the supervisor is willing to run: only proves
 * the repo moved somehow (dirty working tree, or new commits past the
 * attempt's base) — never that the work is correct. Shared by two fallback
 * paths that are really the same situation: `infer.ts`'s "do" command
 * couldn't infer anything more specific from the sentence, and the daemon's
 * planner falls back to it if the `decompose` brain call itself fails, so an
 * objective is never left un-submittable just because planning didn't work.
 *
 * Shells out to a bundled Node script rather than POSIX `test`/`grep` —
 * those depend on coreutils being on PATH, which a bare Windows
 * PowerShell/cmd.exe session doesn't guarantee (confirmed: this silently
 * broke acceptance checks there). `node <script>` has no such dependency.
 */
const checkRepoChangedScript = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "bin",
  "check-repo-changed.mjs",
);

export function weakChangedCheck(): AcceptanceCheck {
  return {
    label: "something changed",
    command: `node "${checkRepoChangedScript}"`,
    expectExitCode: 0,
    timeoutMs: 10_000,
  };
}
