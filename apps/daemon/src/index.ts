#!/usr/bin/env node
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
import { driveTask } from "./engine.js";

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
 */
function recoverOrphans(db: Db): void {
  const orphaned = db
    .select()
    .from(tasks)
    .all()
    .filter((t) => t.status === "running" || t.status === "parked");
  if (orphaned.length === 0) return;

  for (const task of orphaned) {
    setTaskStatus(db, task.id, "ready", "recovered after daemon restart");
  }

  const objectiveIds = new Set(orphaned.map((t) => t.objectiveId));
  const TERMINAL = new Set(["done", "failed", "cancelled"]);
  for (const objective of db.select().from(objectives).all()) {
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

  mainLoop(db).catch((err: unknown) => {
    console.error("daemon loop crashed:", err);
    releasePidFile();
    process.exit(1);
  });
}

main();
