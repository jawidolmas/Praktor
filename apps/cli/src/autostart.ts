import {
  AUTOSTART_MODE_EXPLANATIONS,
  AUTOSTART_TASK_NAME,
  autostartStatus,
  runPowerShellScript,
  type AutostartMode,
} from "@exec/db";
import { writeDaemonLauncher } from "./daemon-client.js";

/**
 * Installing/removing the registration that makes the daemon start itself —
 * surviving the terminal closing (daemon-client.ts) was never enough to make
 * "walk away for three days" true if the machine actually reboots.
 *
 * The read-only status check and the "logon" vs "boot" tradeoff live in
 * @exec/db (see packages/db/src/autostart.ts) since the dashboard needs the
 * exact same answer without reaching into this CLI package. Only the
 * install/uninstall actions live here, because they need `writeDaemonLauncher`
 * — a CLI-specific way of finding tsx and the daemon entry point.
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

export function installAutostart(mode: AutostartMode): InstallAutostartResult {
  if (process.platform !== "win32") {
    return { ok: false, mode, message: "Autostart is only implemented for Windows so far." };
  }

  const launcherPath = writeDaemonLauncher();
  const escapedPath = launcherPath.replace(/'/g, "''");
  const commonLines = [
    `$Action = New-ScheduledTaskAction -Execute '${escapedPath}'`,
    "$Settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries " +
      "-DontStopIfGoingOnBatteries -StartWhenAvailable",
  ];
  const script =
    mode === "logon"
      ? [
          ...commonLines,
          '$Trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\\$env:USERNAME"',
          `Register-ScheduledTask -TaskName '${AUTOSTART_TASK_NAME}' -Action $Action ` +
            "-Trigger $Trigger -Settings $Settings -Force | Out-Null",
        ].join("\n")
      : [
          ...commonLines,
          "$Trigger = New-ScheduledTaskTrigger -AtStartup",
          '$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" ' +
            "-LogonType S4U -RunLevel Limited",
          `Register-ScheduledTask -TaskName '${AUTOSTART_TASK_NAME}' -Action $Action ` +
            "-Trigger $Trigger -Settings $Settings -Principal $Principal -Force | Out-Null",
        ].join("\n");

  const result = runPowerShellScript(script);
  if (result.ok) {
    return {
      ok: true,
      mode,
      message: `Registered to start at ${mode === "logon" ? "login" : "system boot"}. ${AUTOSTART_MODE_EXPLANATIONS[mode]}`,
    };
  }

  const accessDenied = /access is denied/i.test(result.stderr);
  return {
    ok: false,
    mode,
    message: accessDenied
      ? `Could not register: this needs an elevated (Administrator) terminal for "${mode}" mode. ` +
        'Right-click your terminal, "Run as Administrator," and try again.'
      : `Could not register the scheduled task: ${result.stderr.trim() || "unknown error"}`,
  };
}

export function uninstallAutostart(): { removed: boolean; message: string } {
  if (process.platform !== "win32") {
    return { removed: false, message: "Autostart is only implemented for Windows so far." };
  }
  if (!autostartStatus().installed) {
    return { removed: false, message: "Autostart was not registered." };
  }

  const result = runPowerShellScript(
    `Unregister-ScheduledTask -TaskName '${AUTOSTART_TASK_NAME}' -Confirm:$false`,
  );
  return result.ok
    ? { removed: true, message: "Autostart removed — the daemon will no longer start on its own." }
    : { removed: false, message: `Could not remove the scheduled task: ${result.stderr.trim() || "unknown error"}` };
}
