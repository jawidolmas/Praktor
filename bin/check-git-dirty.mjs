#!/usr/bin/env node
import { execSync } from "node:child_process";

/**
 * Exit 0 if the working tree (tracked or untracked) has any change, 1 if clean.
 *
 * The generic "something changed" fallback acceptance check, for a request the
 * infer heuristic couldn't turn into a specific file check. Runs `git status
 * --porcelain` and inspects the output directly in Node rather than piping
 * through `grep -q .` — same reasoning as check-exists.mjs: no dependency on
 * external POSIX utilities being on PATH, only on git and Node, both of which
 * are already required for exec-agent to run at all.
 */
try {
  const out = execSync("git status --porcelain", { encoding: "utf8" });
  process.exit(out.trim().length > 0 ? 0 : 1);
} catch {
  process.exit(1);
}
