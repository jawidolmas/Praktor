import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { AcceptanceCheck, AcceptanceSpec } from "@exec/core";

/**
 * The acceptance gate.
 *
 * This is the anti-hallucination backbone the whole design leans on: a command's
 * real exit code is believed, a worker's claim of success is not. Nothing here
 * inspects what the worker said about itself.
 */

/**
 * Find Git for Windows' bundled bash.exe, so acceptance checks run through a
 * real POSIX shell instead of cmd.exe (Node's spawnSync default on Windows
 * when `shell: true`). Confirmed live: a planner-written check using `test -f`
 * or `grep` — the ordinary, expected way to write "a real shell command," and
 * exactly what PLANNER_INSTRUCTIONS asks for — failed on every single attempt
 * with "'test' is not recognized as an internal or external command," even
 * though the worker had written the file correctly every time. No number of
 * retries can ever pass a check like that under cmd.exe; only "accept the
 * failure" ever unblocks it, which is a different problem entirely from the
 * task actually being wrong.
 *
 * Git itself is already a hard dependency of this whole system, so its
 * bundled bash is always present alongside it — this just has to find it,
 * without assuming a specific install layout (the standard installer puts
 * git.exe under `cmd\` or `mingw64\bin\`, with bash.exe two or so directories
 * up under `bin\` or `usr\bin\`). Never touches WSL's `System32\bash.exe`
 * (an entirely different environment with its own filesystem view) because
 * that's never what `where git.exe` points anywhere near.
 */
function findWindowsBash(): string | undefined {
  const fixedCandidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
  ];

  let gitPath: string | undefined;
  try {
    gitPath = execFileSync("where", ["git.exe"], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
  } catch {
    /* `where` failed or git isn't found this way — the fixed candidates below still might exist */
  }

  const derived: string[] = [];
  if (gitPath) {
    let dir = dirname(gitPath);
    for (let i = 0; i < 3; i++) {
      derived.push(join(dir, "bin", "bash.exe"), join(dir, "usr", "bin", "bash.exe"));
      dir = dirname(dir);
    }
  }

  return [...derived, ...fixedCandidates].find((p) => existsSync(p));
}

const WINDOWS_BASH = process.platform === "win32" ? findWindowsBash() : undefined;
// `test` is a bash builtin so bash alone is enough for it, but `grep`, `diff`,
// `sed` and the rest of coreutils are real executables living in that same
// directory as bash.exe — and the real daemon process's inherited PATH
// (confirmed live) has only `Git\cmd` on it, not this. Prepending it here,
// per check, means a check resolves the same coreutils regardless of what
// PATH the process that started the daemon happened to have.
const WINDOWS_BASH_DIR = WINDOWS_BASH ? dirname(WINDOWS_BASH) : undefined;

export interface CheckOutcome {
  label: string;
  command: string;
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** Set when the process could not even be started or timed out. */
  runError?: string;
}

export interface VerifyOutcome {
  passed: boolean;
  checks: CheckOutcome[];
}

function runCheck(cwd: string, check: AcceptanceCheck, extraEnv?: Record<string, string>): CheckOutcome {
  const startedAt = Date.now();
  const path = WINDOWS_BASH_DIR
    ? `${WINDOWS_BASH_DIR}${delimiter}${process.env["PATH"] ?? ""}`
    : process.env["PATH"];
  const res = spawnSync(check.command, {
    cwd,
    shell: WINDOWS_BASH ?? true,
    timeout: check.timeoutMs,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    // The daemon that runs this has no console of its own — without this,
    // Windows opens a fresh, visible one for the check command every time,
    // and closing it kills the check mid-run rather than just failing it.
    windowsHide: true,
    env: { ...process.env, PATH: path, ...extraEnv },
  });
  const durationMs = Date.now() - startedAt;
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";

  if (res.error) {
    return {
      label: check.label,
      command: check.command,
      passed: false,
      exitCode: null,
      durationMs,
      stdout,
      stderr,
      runError: res.error.message,
    };
  }

  let passed = res.status === check.expectExitCode;
  if (passed && check.expectStdout) passed = stdout.includes(check.expectStdout);

  return {
    label: check.label,
    command: check.command,
    passed,
    exitCode: res.status,
    durationMs,
    stdout,
    stderr,
  };
}

/** Run every acceptance check for a task in order, stopping at the first available
 *  answer for each — all checks always run, so a report shows the complete picture
 *  rather than just the first failure. `extraEnv` is how the caller hands a check
 *  command context it has no other way to reach — e.g. the attempt's base commit,
 *  which lets the generic "something changed" check tell a real commit-and-push
 *  apart from nothing having happened, something a plain dirty-tree check can't. */
export function runAcceptance(
  cwd: string,
  spec: AcceptanceSpec,
  extraEnv?: Record<string, string>,
): VerifyOutcome {
  const checks = spec.checks.map((check) => runCheck(cwd, check, extraEnv));
  return { passed: checks.every((c) => c.passed), checks };
}
