import { createRequire } from "node:module";
import { openSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findRunningDaemon, logFilePath } from "@exec/db";

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

function spawnDaemon(): void {
  const require = createRequire(import.meta.url);
  const tsxCli = require.resolve("tsx/cli");
  const logFd = openSync(logFilePath(), "a");
  const child = spawn(process.execPath, [tsxCli, daemonEntry], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    // Without this, Windows pops up a visible console window for the
    // daemon — found live: a person who didn't spawn it themselves has no
    // reason to expect that window and every reason to close what looks
    // like a stray popup, which kills the daemon (Windows' console close
    // isn't a signal Node reliably catches as a graceful shutdown, so it
    // dies with no log line at all). `windowsHide` is a no-op on other
    // platforms, so this is safe to always pass.
    windowsHide: true,
  });
  child.unref();
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

export function stopDaemon(): { stopped: boolean; pid?: number } {
  const pid = findRunningDaemon();
  if (pid === undefined) return { stopped: false };
  process.kill(pid, "SIGTERM");
  return { stopped: true, pid };
}
