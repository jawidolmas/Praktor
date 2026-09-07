#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";

/**
 * Exit 0 if the given path exists and is non-empty, 1 otherwise.
 *
 * Used as an acceptance check command (`node <this file> <path>`) instead of
 * the POSIX `test -f X && test -s X` idiom — that idiom depends on external
 * `test`/coreutils binaries being on PATH, which is true in a Git Bash shell
 * but not guaranteed in a bare Windows PowerShell/cmd.exe session. Node itself
 * is guaranteed to be on PATH (exec-agent runs on it), so this has no external
 * dependency at all and behaves identically on every platform and shell.
 */
const target = process.argv[2];
if (!target) {
  console.error("usage: check-exists.mjs <path>");
  process.exit(2);
}

try {
  process.exit(existsSync(target) && statSync(target).size > 0 ? 0 : 1);
} catch {
  process.exit(1);
}
