#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Exit 0 if the given path exists with that exact casing and is non-empty, 1
 * otherwise.
 *
 * Used as an acceptance check command (`node <this file> <path>`) instead of
 * the POSIX `test -f X && test -s X` idiom — that idiom depends on external
 * `test`/coreutils binaries being on PATH, which is true in a Git Bash shell
 * but not guaranteed in a bare Windows PowerShell/cmd.exe session. Node itself
 * is guaranteed to be on PATH (exec-agent runs on it), so this has no external
 * dependency at all and behaves identically on every platform and shell.
 *
 * Exact-case matters and existsSync alone is not enough for it: on a
 * case-insensitive filesystem (Windows, default macOS), existsSync("test.md")
 * resolves to an existing "TEST.md" too — so a request for a new "test.md"
 * that collides with an already-existing "TEST.md" would falsely PASS this
 * check off the pre-existing file, even if the worker (correctly) avoided
 * overwriting it and created the real content somewhere else entirely.
 * readdirSync returns the real on-disk casing, so comparing against that
 * directly is the way to tell "the requested file was actually created" from
 * "a differently-cased file happens to already be there".
 */
const target = process.argv[2];
if (!target) {
  console.error("usage: check-exists.mjs <path>");
  process.exit(2);
}

try {
  const dir = dirname(target) || ".";
  const base = basename(target);
  const entries = readdirSync(dir);
  if (!entries.includes(base)) {
    process.exit(1);
  }
  const full = join(dir, base);
  process.exit(existsSync(full) && statSync(full).size > 0 ? 0 : 1);
} catch {
  process.exit(1);
}
