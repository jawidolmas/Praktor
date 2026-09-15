#!/usr/bin/env node
import { openDb, runMigrations } from "@exec/db";
import { startAutostartStatusCache } from "./api.js";
import { createDashboardServer } from "./server.js";

function main(): void {
  const port = Number(process.env["EXEC_WEB_PORT"] ?? 4317);
  const host = process.env["EXEC_WEB_HOST"] ?? "127.0.0.1";

  const { db, path } = openDb();
  // Same defensive migrate-before-read as `exec-agent events` — the dashboard
  // can be the very first thing that opens a fresh $EXEC_HOME.
  runMigrations(db);

  // One (~1.4s, PowerShell) call up front, then refreshed in the background —
  // see startAutostartStatusCache's own comment for why this can never live
  // on the request path.
  startAutostartStatusCache();

  const server = createDashboardServer(db);
  server.listen(port, host, () => {
    console.log(`Praktor dashboard: http://${host}:${port}`);
    console.log(`Reading:           ${path}`);
  });
}

main();
