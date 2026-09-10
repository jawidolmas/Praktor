#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  claimPidFile,
  logFilePath,
  objectives,
  openDb,
  readyTasks,
  releasePidFile,
  runMigrations,
  schedulableObjectives,
  setObjectiveStatus,
  setTaskStatus,
  tasks,
  type Db,
} from "@exec/db";
import { reconcileSeedPolicies } from "@exec/policy";
import { attemptBranchName, removeWorktree } from "@exec/worker";
import { driveTask, worktreePathFor } from "./engine.js";
import { loadTelegramConfig, runTelegramBridge } from "./telegram-bridge.js";

/**
 * The daemon is launched detached, by `spawnDaemon` in the CLI, with no
 * shell profile behind it — so config in `.env` (TELEGRAM_BOT_TOKEN and
 * friends) would otherwise never reach it no matter what the invoking
 * terminal has exported. Resolved against this file's own location, not
 * `process.cwd()`, because the daemon can be started while sitting in any
 * repo `do`/`run` was pointed at — same reasoning as `execHome()` being
 * fixed rather than cwd-relative. `loadEnvFile` only landed in Node
 * 20.12/21.7; guarded rather than required, since package.json's floor is
 * plain "20".
 */
function loadDotEnv(): void {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const loadEnvFile = (process as { loadEnvFile?: (path: string) => void }).loadEnvFile;
  if (!loadEnvFile) return;
  try {
    loadEnvFile(join(repoRoot, ".env"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * The daemon: the persistent process that actually drives objectives, so
 * that closing the terminal that submitted one — or the whole laptop — does
 * not stop it. `apps/cli` only ever inserts rows and tails the event log; this
 * is the only process that calls `driveTask`.
 */

const IDLE_POLL_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Tasks left "running" or "parked" are only valid states while a daemon is
 * actively driving them. Finding one at startup means the previous instance
 * died mid-attempt (crash, or a forced stop) — not that the work is invalid,
 * just that nobody is waiting on it anymore. Requeue it; `driveTask` resumes
 * from `task.attempts` already persisted, so no completed attempt is redone.
 *
 * A "blocked" task is left alone — that's a decision still genuinely
 * awaiting an answer, valid independent of whether the daemon is up, and
 * `answerDecision` (called from the CLI or the dashboard, neither of which
 * needs the daemon running) already makes it schedulable again on its own.
 *
 * The retry reuses the exact same attempt number and worktree/branch the
 * crashed daemon was using (an attempt only counts once it concludes — see
 * engine.ts), so if that worktree is still sitting on disk, `git worktree
 * add` for the retry collides with it ("already used by worktree at ...").
 * Found live: a daemon that died mid-attempt left exactly this behind, and
 * the very next restart failed the same way trying to recreate it. Cleaning
 * up first — safe even when there is nothing to clean up — is what makes a
 * restart actually resume instead of failing the same way again.
 */
function recoverOrphans(db: Db): void {
  const orphaned = db
    .select()
    .from(tasks)
    .all()
    .filter((t) => t.status === "running" || t.status === "parked");
  if (orphaned.length === 0) return;

  const allObjectives = db.select().from(objectives).all();
  const objectiveById = new Map(allObjectives.map((o) => [o.id, o] as const));

  for (const task of orphaned) {
    const objective = objectiveById.get(task.objectiveId);
    if (objective) {
      const attempt = task.attempts + 1;
      removeWorktree({
        repoPath: objective.repoPath,
        path: worktreePathFor(task.id, attempt),
        branch: attemptBranchName(task.id, attempt),
        baseSha: "",
      });
    }
    setTaskStatus(db, task.id, "ready", "recovered after daemon restart");
  }

  const objectiveIds = new Set(orphaned.map((t) => t.objectiveId));
  const TERMINAL = new Set(["done", "failed", "cancelled"]);
  for (const objective of allObjectives) {
    if (objectiveIds.has(objective.id) && !TERMINAL.has(objective.status)) {
      setObjectiveStatus(db, objective.id, "active", "recovered after daemon restart");
    }
  }

  console.log(`Recovered ${orphaned.length} task(s) orphaned by a previous daemon instance.`);
}

function pickNextTask(db: Db): { task: (typeof tasks.$inferSelect); objective: (typeof objectives.$inferSelect) } | undefined {
  for (const objective of schedulableObjectives(db)) {
    const [task] = readyTasks(db, objective.id);
    if (task) return { task, objective };
  }
  return undefined;
}

async function mainLoop(db: Db): Promise<never> {
  for (;;) {
    const next = pickNextTask(db);
    if (!next) {
      await sleep(IDLE_POLL_MS);
      continue;
    }
    try {
      await driveTask(db, next.task, next.objective);
    } catch (err) {
      // A task-level failure must never take the whole daemon down with it —
      // every other queued objective still deserves its turn.
      console.error(`[${next.objective.id.slice(0, 8)}] task crashed unexpectedly:`, err);
      setTaskStatus(db, next.task.id, "failed", "unexpected error — see daemon.log");
      setObjectiveStatus(db, next.objective.id, "failed", "unexpected error");
    }
  }
}

function main(): void {
  loadDotEnv();

  const claim = claimPidFile();
  if (!claim.claimed) {
    console.log(`A daemon is already running (pid ${claim.existingPid}). Exiting.`);
    return;
  }

  // Stop means stop now, not "after the current attempt finishes" — an
  // attempt in flight can be an arbitrarily long-running SDK call. Recovery
  // on the next start is what makes an abrupt exit safe: nothing here is
  // left in a state recoverOrphans() can't pick back up.
  const shutdown = (signal: string): void => {
    console.log(`\n${signal} received — stopping now. Work in progress resumes from a future "exec-agent daemon start".`);
    releasePidFile();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  const { db, path } = openDb();
  runMigrations(db);
  reconcileSeedPolicies(db);
  recoverOrphans(db);

  console.log(`Praktor daemon started (pid ${process.pid}).`);
  console.log(`Database: ${path}`);
  console.log(`Log:      ${logFilePath()}`);

  const telegramConfig = loadTelegramConfig();
  if (telegramConfig) {
    // Fire-and-forget, deliberately not awaited: its own internal loops
    // already catch and retry forever, so this only rejects on a genuine
    // programming error — and even then, a broken notification channel
    // must not stop the daemon from driving tasks.
    runTelegramBridge(db, telegramConfig).catch((err: unknown) => {
      console.error("[telegram] bridge crashed and will not restart until the daemon does:", err);
    });
  } else {
    console.log("Telegram bridge: disabled (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable).");
  }

  mainLoop(db).catch((err: unknown) => {
    console.error("daemon loop crashed:", err);
    releasePidFile();
    process.exit(1);
  });
}

main();
