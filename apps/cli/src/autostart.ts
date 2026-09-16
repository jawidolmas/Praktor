import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  AUTOSTART_MODE_EXPLANATIONS,
  AUTOSTART_TASK_NAME,
  autostartStatus,
  runPowerShellScript,
  startupFolderShortcutPath,
  type AutostartMode,
} from "@exec/db";
import { writeDaemonLauncher } from "./daemon-client.js";

/**
 * Installing/removing the registration that makes the daemon start itself —
 * surviving the terminal closing (daemon-client.ts) was never enough to make
 * "walk away for three days" true if the machine actually reboots.
 *
 * The read-only status check, the Startup-folder path, and the "logon" vs
 * "boot" tradeoff live in @exec/db (see packages/db/src/autostart.ts) since
 * the dashboard needs the exact same answer without reaching into this CLI
 * package. Only the install/uninstall actions live here, because they need
 * `writeDaemonLauncher` — a CLI-specific way of finding tsx and the daemon
 * entry point.
 */

export {
  AUTOSTART_MODE_EXPLANATIONS,
  autostartStatus,
  parseAutostartStatusOutput,
  type AutostartMode,
  type AutostartStatus,
} from "@exec/db";

export interface InstallAutostartResult {
  ok: boolean;
  mode: AutostartMode;
  message: string;
}

function removeStartupFolderShortcutIfPresent(): void {
  const shortcutPath = startupFolderShortcutPath();
  if (!shortcutPath || !existsSync(shortcutPath)) return;
  try {
    rmSync(shortcutPath, { force: true });
  } catch {
    /* best effort — install/uninstall already report their own outcome */
  }
}

function removeScheduledTaskIfPresent(): void {
  runPowerShellScript(
    `if (Get-ScheduledTask -TaskName '${AUTOSTART_TASK_NAME}' -ErrorAction SilentlyContinue) { ` +
      `Unregister-ScheduledTask -TaskName '${AUTOSTART_TASK_NAME}' -Confirm:$false }`,
  );
}

function installLogon(launcherPath: string): InstallAutostartResult {
  const shortcutPath = startupFolderShortcutPath();
  if (!shortcutPath) {
    return { ok: false, mode: "logon", message: "Could not resolve the Windows Startup folder (%APPDATA% is not set)." };
  }
  try {
    mkdirSync(dirname(shortcutPath), { recursive: true });
    writeFileSync(shortcutPath, `@echo off\r\ncall "${launcherPath}"\r\n`, "utf8");
  } catch (err) {
    return { ok: false, mode: "logon", message: `Could not write to the Startup folder: ${err instanceof Error ? err.message : String(err)}` };
  }
  // Only clean up an old boot-mode registration once the new one is
  // confirmed in place — never leave neither registered because the switch
  // half-failed.
  removeScheduledTaskIfPresent();
  return { ok: true, mode: "logon", message: `Registered to start at login (Startup folder). ${AUTOSTART_MODE_EXPLANATIONS.logon}` };
}

function installBoot(launcherPath: string): InstallAutostartResult {
  const escapedPath = launcherPath.replace(/'/g, "''");
  const script = [
    // -Execute has to be cmd.exe itself, with the launcher passed as its /c
    // argument — pointing -Execute straight at a .cmd path registers without
    // error but Task Scheduler's own process-launch path does not reliably
    // run it (confirmed live via its operational event log: sometimes
    // ERROR_INVALID_FUNCTION, sometimes a reported success that silently
    // executes nothing). "logon" mode sidesteps this by using the Startup
    // folder instead — see installLogon — but "boot" (run before any login)
    // has no alternative to a Scheduled Task.
    `$Action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c "${escapedPath}"'`,
    "$Settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries " +
      "-DontStopIfGoingOnBatteries -StartWhenAvailable",
    "$Trigger = New-ScheduledTaskTrigger -AtStartup",
    '$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" ' +
      "-LogonType S4U -RunLevel Limited",
    `Register-ScheduledTask -TaskName '${AUTOSTART_TASK_NAME}' -Action $Action ` +
      "-Trigger $Trigger -Settings $Settings -Principal $Principal -Force | Out-Null",
  ].join("\n");

  const result = runPowerShellScript(script);
  if (!result.ok) {
    const accessDenied = /access is denied/i.test(result.stderr);
    return {
      ok: false,
      mode: "boot",
      message: accessDenied
        ? 'Could not register: this needs an elevated (Administrator) terminal for "boot" mode. ' +
          'Right-click your terminal, "Run as Administrator," and try again.'
        : `Could not register the scheduled task: ${result.stderr.trim() || "unknown error"}`,
    };
  }
  removeStartupFolderShortcutIfPresent();
  return { ok: true, mode: "boot", message: `Registered to start at system boot. ${AUTOSTART_MODE_EXPLANATIONS.boot}` };
}

export function installAutostart(mode: AutostartMode): InstallAutostartResult {
  if (process.platform !== "win32") {
    return { ok: false, mode, message: "Autostart is only implemented for Windows so far." };
  }
  const launcherPath = writeDaemonLauncher();
  return mode === "logon" ? installLogon(launcherPath) : installBoot(launcherPath);
}

export function uninstallAutostart(): { removed: boolean; message: string } {
  if (process.platform !== "win32") {
    return { removed: false, message: "Autostart is only implemented for Windows so far." };
  }
  if (!autostartStatus().installed) {
    return { removed: false, message: "Autostart was not registered." };
  }

  // Both are attempted, idempotently, regardless of which one autostartStatus
  // actually reported — a machine upgraded from before the Startup-folder
  // fix could have a leftover Scheduled Task alongside a fresh Startup entry,
  // and leaving either behind would mean "uninstall" didn't actually mean it.
  removeStartupFolderShortcutIfPresent();
  const result = runPowerShellScript(
    `if (Get-ScheduledTask -TaskName '${AUTOSTART_TASK_NAME}' -ErrorAction SilentlyContinue) { ` +
      `Unregister-ScheduledTask -TaskName '${AUTOSTART_TASK_NAME}' -Confirm:$false }`,
  );
  return result.ok
    ? { removed: true, message: "Autostart removed — the daemon will no longer start on its own." }
    : { removed: false, message: `Could not remove the scheduled task: ${result.stderr.trim() || "unknown error"}` };
}
