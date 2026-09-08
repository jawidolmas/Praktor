import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execHome } from "./client.js";

/**
 * Single-instance locking for the daemon via a pidfile — the standard
 * mechanism for "make sure only one of me is running," chosen over a DB
 * advisory lock because it also answers "is it running at all" for the CLI
 * (`daemon status`, and `ensureDaemonRunning` deciding whether to spawn one)
 * without opening the database at all.
 *
 * Lives alongside `execHome()` in `@exec/db` rather than in `apps/daemon`
 * because both the CLI and the daemon need to agree on where this is —
 * exactly the kind of thing that belongs in the one package everything
 * already depends on, not duplicated or reached into across an app boundary.
 */

export const pidFilePath = (): string => join(execHome(), "daemon.pid");
export const logFilePath = (): string => join(execHome(), "daemon.log");

/** Whether a process with this pid exists — not necessarily one we can
 *  signal (EPERM still means "exists"), only ESRCH means it does not. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readPidFile(): number | undefined {
  if (!existsSync(pidFilePath())) return undefined;
  const raw = readFileSync(pidFilePath(), "utf8").trim();
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** The already-running daemon's pid, or undefined if none is alive — cleans
 *  up a stale pidfile left behind by a crash along the way. */
export function findRunningDaemon(): number | undefined {
  const pid = readPidFile();
  if (pid === undefined) return undefined;
  if (isAlive(pid)) return pid;
  rmSync(pidFilePath(), { force: true });
  return undefined;
}

export type ClaimResult = { claimed: true } | { claimed: false; existingPid: number };

/** Called by the daemon process itself at startup. Refuses to claim the lock
 *  if another instance already holds it and is actually alive. */
export function claimPidFile(): ClaimResult {
  const existing = findRunningDaemon();
  if (existing !== undefined) return { claimed: false, existingPid: existing };
  writeFileSync(pidFilePath(), String(process.pid), "utf8");
  return { claimed: true };
}

/** Only removes the pidfile if it still names this process — never clobber a
 *  newer daemon's claim on a delayed shutdown. */
export function releasePidFile(): void {
  if (readPidFile() === process.pid) rmSync(pidFilePath(), { force: true });
}
