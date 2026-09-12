import { execFileSync } from "node:child_process";

/**
 * Whether — and how — the daemon is registered to start itself, so "walk
 * away for three days" survives the machine actually rebooting, not just the
 * terminal closing (which `daemon.ts`'s pidfile already covers). Lives here,
 * not in `apps/cli`, because both the CLI (which installs/uninstalls it) and
 * the dashboard (which only needs to display it) have to agree on what
 * "installed" means without one app reaching into the other's internals.
 *
 * Windows-only for now (this whole system runs on a Windows box today); on
 * any other platform this reports "not installed" rather than erroring, so
 * callers don't need their own platform branch.
 */

export type AutostartMode = "logon" | "boot";

export interface AutostartStatus {
  installed: boolean;
  mode?: AutostartMode;
}

export const AUTOSTART_TASK_NAME = "PraktorDaemon";

export const AUTOSTART_MODE_EXPLANATIONS: Record<AutostartMode, string> = {
  logon: "Starts the daemon when you next log into Windows. No special privileges needed.",
  boot:
    "Starts the daemon as Windows boots, before anyone logs in. Needs an elevated " +
    '(Administrator) terminal to register — right-click your terminal, "Run as Administrator."',
};

/** Shells out to a PowerShell script and captures its output — shared by
 *  every autostart operation (here and in apps/cli's install/uninstall) so
 *  there is one place that gets the quoting, encoding, and output-capture
 *  right instead of several drifting copies. */
export function runPowerShellScript(script: string): { ok: boolean; stdout: string; stderr: string } {
  // Without this, a cmdlet's progress bar (Register-ScheduledTask shows one)
  // serializes as CLIXML noise into the output stream under -NonInteractive,
  // polluting both a real user's terminal and stderr-based error detection.
  const fullScript = `$ProgressPreference = 'SilentlyContinue'\n${script}`;
  const encoded = Buffer.from(fullScript, "utf16le").toString("base64");
  try {
    const stdout = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      // execFileSync passes a child's stderr through to our own by default
      // (only stdout is captured) — explicit "pipe" is what actually
      // captures it instead of dumping raw CLIXML into the user's terminal.
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message };
  }
}

/** Pulled out so the parsing itself is testable without a real PowerShell
 *  call — the only part of `autostartStatus` worth unit-testing directly. */
export function parseAutostartStatusOutput(stdout: string): AutostartStatus {
  const line = stdout.trim();
  if (line === "INSTALLED:logon") return { installed: true, mode: "logon" };
  if (line === "INSTALLED:boot") return { installed: true, mode: "boot" };
  if (line.startsWith("INSTALLED:")) return { installed: true }; // a trigger type we don't recognize
  return { installed: false };
}

export function autostartStatus(): AutostartStatus {
  if (process.platform !== "win32") return { installed: false };

  const script = [
    `$t = Get-ScheduledTask -TaskName '${AUTOSTART_TASK_NAME}' -ErrorAction SilentlyContinue`,
    "if ($t) {",
    "  $triggerType = $t.Triggers[0].CimClass.CimClassName",
    "  if ($triggerType -eq 'MSFT_TaskBootTrigger') { Write-Output 'INSTALLED:boot' }",
    "  elseif ($triggerType -eq 'MSFT_TaskLogonTrigger') { Write-Output 'INSTALLED:logon' }",
    "  else { Write-Output 'INSTALLED:other' }",
    "} else {",
    "  Write-Output 'NOT_INSTALLED'",
    "}",
  ].join("\n");

  return parseAutostartStatusOutput(runPowerShellScript(script).stdout);
}
