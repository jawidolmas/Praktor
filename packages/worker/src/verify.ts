import { spawnSync } from "node:child_process";
import type { AcceptanceCheck, AcceptanceSpec } from "@exec/core";

/**
 * The acceptance gate.
 *
 * This is the anti-hallucination backbone the whole design leans on: a command's
 * real exit code is believed, a worker's claim of success is not. Nothing here
 * inspects what the worker said about itself.
 */

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

function runCheck(cwd: string, check: AcceptanceCheck): CheckOutcome {
  const startedAt = Date.now();
  const res = spawnSync(check.command, {
    cwd,
    shell: true,
    timeout: check.timeoutMs,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
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
 *  rather than just the first failure. */
export function runAcceptance(cwd: string, spec: AcceptanceSpec): VerifyOutcome {
  const checks = spec.checks.map((check) => runCheck(cwd, check));
  return { passed: checks.every((c) => c.passed), checks };
}
