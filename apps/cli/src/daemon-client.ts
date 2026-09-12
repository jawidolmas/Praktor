import { createRequire } from "node:module";
import { openSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findRunningDaemon, isAlive, logFilePath } from "@exec/db";

/**
 * Launching and checking on the daemon from the CLI's side. The daemon is a
 * separate, detached process on purpose: it must survive this CLI process
 * exiting (Ctrl-C on `do`, or the whole terminal closing), which is the
 * entire point of having one.
 */

const daemonEntry = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "daemon",
  "src",
  "index.ts",
);

/**
 * On Windows, Node's own `detached: true` + `windowsHide: true` combination
 * is not reliable — a known libuv limitation where `detached` can force a
 * visible console window regardless of `windowsHide`. Confirmed live, twice:
 * that combination left a real, persistent window open (titled after
 * node.exe) with nothing about it to distinguish it from a stray popup —
 * closing it killed the daemon the same way every time.
 *
 * `Start-Process -WindowStyle Hidden` goes through a different, more
 * reliable path — confirmed by enumerating actual visible windows
 * before/after that it creates none. It launches a tiny generated .cmd
 * script rather than the target command inline: `cmd.exe /c` and
 * PowerShell's own argument re-quoting don't compose cleanly for a command
 * line built from several separately-quoted paths (confirmed: that shape
 * silently failed to launch anything), whereas a plain batch file with
 * normal quoting has no cross-boundary escaping to get wrong. The command
 * handed to the outer PowerShell is base64-encoded (`-EncodedCommand`)
 * specifically so a path containing spaces or quotes never has to survive
 * being embedded in a hand-built command-line string at all.
 */
function spawnDaemonWindows(tsxCli: string): void {
  const log = logFilePath();
  const launcherPath = join(dirname(log), "daemon-launch.cmd");
  const batContent = `@echo off\r\n"${process.execPath}" "${tsxCli}" "${daemonEntry}" >> "${log}" 2>&1\r\n`;
  writeFileSync(launcherPath, batContent, "utf8");

  const script = `Start-Process -FilePath '${launcherPath.replace(/'/g, "''")}' -WindowStyle Hidden`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
    { windowsHide: true, stdio: "ignore" },
  );
  child.unref();
}

function spawnDaemonPosix(tsxCli: string): void {
  const logFd = openSync(logFilePath(), "a");
  const child = spawn(process.execPath, [tsxCli, daemonEntry], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
}

function spawnDaemon(): void {
  const require = createRequire(import.meta.url);
  const tsxCli = require.resolve("tsx/cli");
  if (process.platform === "win32") {
    spawnDaemonWindows(tsxCli);
  } else {
    spawnDaemonPosix(tsxCli);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Start a daemon if none is already running, and wait briefly for it to
 * actually claim the pidfile — so a caller printing "queued" right after can
 * trust the daemon is really there to pick the work up, not still starting.
 */
export async function ensureDaemonRunning(): Promise<{ started: boolean; pid: number }> {
  const existing = findRunningDaemon();
  if (existing !== undefined) return { started: false, pid: existing };

  spawnDaemon();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const pid = findRunningDaemon();
    if (pid !== undefined) return { started: true, pid };
    await sleep(200);
  }
  throw new Error(
    `Started a daemon process but it never claimed its pidfile within 10s. Check ${logFilePath()} for what went wrong.`,
  );
}

export function daemonStatus(): { running: boolean; pid?: number } {
  const pid = findRunningDaemon();
  return pid === undefined ? { running: false } : { running: true, pid };
}

const STOP_CONFIRM_TIMEOUT_MS = 5_000;
const STOP_POLL_INTERVAL_MS = 100;

/**
 * Sends the stop signal and waits to actually see the process gone, rather
 * than reporting success the instant the signal is sent. Confirmed live:
 * without this, a caller (a script, or a human moving fast — `daemon stop`
 * immediately followed by a new `do`/`watch`) has no way to tell "the old
 * daemon is definitely gone" from "the signal was sent and who knows." On
 * Windows in particular `process.kill(pid, "SIGTERM")` maps to
 * `TerminateProcess`, which *requests* termination but is not guaranteed
 * instantaneous — the pid can briefly still answer `isAlive` afterward.
 * `confirmed: false` is a real, distinct outcome callers must surface, not
 * something to swallow into a blanket "stopped".
 *
 * `timeoutMs`/`pollIntervalMs` are overridable only so tests can exercise the
 * "still alive after the deadline" branch quickly — real callers should
 * always use the defaults.
 */
export async function stopDaemon(
  opts: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<{ stopped: boolean; pid?: number; confirmed?: boolean }> {
  const pid = findRunningDaemon();
  if (pid === undefined) return { stopped: false };
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    // Gone between us reading the pidfile and signaling it (e.g. it crashed
    // or was stopped by someone else moments ago) — that's success, not an error.
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return { stopped: true, pid, confirmed: true };
    throw err;
  }

  const timeoutMs = opts.timeoutMs ?? STOP_CONFIRM_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? STOP_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return { stopped: true, pid, confirmed: true };
    await sleep(pollIntervalMs);
  }
  return { stopped: true, pid, confirmed: false };
}
