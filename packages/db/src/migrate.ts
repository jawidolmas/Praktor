import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openDb } from "./client.js";
import type { Db } from "./client.js";

/** Migrations live next to the package, not the caller's cwd. */
export const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder });
}

// `npm run db:migrate`
const invokedPath = process.argv[1];
if (invokedPath && fileURLToPath(import.meta.url) === resolve(invokedPath)) {
  const { db, path } = openDb();
  runMigrations(db);
  console.log(`migrated ${path}`);
}
