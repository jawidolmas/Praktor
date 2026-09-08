import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

export interface ExecDbHandle {
  db: Db;
  sqlite: SqliteDatabase;
  path: string;
}

export interface OpenDbOptions {
  /** Path to the SQLite file. Defaults to $EXEC_HOME/exec.db. */
  path?: string;
}

/**
 * The supervisor's home directory: the database, the daemon's pidfile and
 * log, and (elsewhere) worktrees all anchor off this one path. Fixed by
 * default rather than resolved against the invoking shell's cwd — this is
 * meant to be one central place regardless of where `exec-agent` is run
 * from, or which process (CLI, daemon, dashboard) is asking. Override
 * EXEC_HOME to scope state to a single project instead.
 */
export function execHome(): string {
  return process.env["EXEC_HOME"] ?? join(homedir(), ".exec-agent");
}

/**
 * Open the supervisor database.
 *
 * WAL is what makes the single-file choice work here: the daemon is the only
 * writer, while the CLI, the Telegram bridge and the dashboard all read
 * concurrently without blocking it.
 */
export function openDb(options: OpenDbOptions = {}): ExecDbHandle {
  const requested = options.path ?? `${execHome()}/exec.db`;
  // ":memory:" is passed through untouched so tests can run without touching disk.
  const path = requested === ":memory:" ? requested : resolve(requested);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  // Durable enough for a local daemon, and much faster than FULL under WAL.
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("busy_timeout = 5000");

  const db = drizzle(sqlite, { schema });
  return { db, sqlite, path };
}
