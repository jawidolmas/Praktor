import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAcceptance } from "./verify.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "verify-test-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("runAcceptance", () => {
  // Windows-only: this reproduces a real daemon environment, which only
  // exists on win32 — cmd.exe is Node's spawnSync default shell there, and
  // is what exposed this. On POSIX the default shell already has test/grep,
  // so there is nothing this fix changes to verify.
  it.runIf(process.platform === "win32")(
    "passes POSIX-style checks (test, grep) even with the minimal PATH the real daemon process inherits",
    () => {
      // Regression, confirmed live: the daemon is launched via a generated
      // .cmd script through a non-interactive PowerShell (daemon-client.ts),
      // which inherits the machine's persisted PATH — on a normal Git for
      // Windows install that's `Git\cmd` (git.exe itself) but NOT `Git\usr\bin`
      // (where test/grep/diff actually live). A planner-authored check using
      // them — exactly the "real shell command" PLANNER_INSTRUCTIONS asks
      // for — failed on every attempt with "'test' is not recognized as an
      // internal or external command," even though the worker had written
      // the file correctly every single time. No number of retries could
      // ever have passed a check like that; only "accept the failure" could.
      const originalPath = process.env["PATH"];
      process.env["PATH"] = "C:\\Program Files\\Git\\cmd";
      try {
        writeFileSync(join(cwd, "CONTRIBUTING.md"), "# Contributing\n\nOpen a pull request.\n");

        const result = runAcceptance(cwd, {
          checks: [
            { label: "file exists", command: "test -f CONTRIBUTING.md", expectExitCode: 0, timeoutMs: 10_000 },
            {
              label: "mentions pull request",
              command: 'grep -qi "pull request" CONTRIBUTING.md',
              expectExitCode: 0,
              timeoutMs: 10_000,
            },
          ],
        });

        expect(result.checks.map((c) => ({ label: c.label, passed: c.passed, stderr: c.stderr }))).toEqual(
          [
            { label: "file exists", passed: true, stderr: "" },
            { label: "mentions pull request", passed: true, stderr: "" },
          ],
        );
        expect(result.passed).toBe(true);
      } finally {
        process.env["PATH"] = originalPath;
      }
    },
  );

  it("still correctly fails a POSIX-style check when the condition is genuinely false", () => {
    const result = runAcceptance(cwd, {
      checks: [
        { label: "file exists", command: "test -f nonexistent.md", expectExitCode: 0, timeoutMs: 10_000 },
      ],
    });

    expect(result.passed).toBe(false);
  });
});
