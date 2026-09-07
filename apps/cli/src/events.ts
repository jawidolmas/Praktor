import { openDb, readEvents } from "@exec/db";

/** Dump the durable event log for an objective — the "come back to a report,
 *  not a transcript" promise, at its most literal: every decision this system
 *  made is a readable row, not a scrollback you have to re-read. */
export function printEvents(objectiveId: string): void {
  const { db } = openDb();
  const rows = readEvents(db, { objectiveId, limit: 5000 });

  if (rows.length === 0) {
    console.log(`No events found for objective ${objectiveId}.`);
    return;
  }

  for (const row of rows) {
    const time = new Date(row.ts).toISOString();
    const scope = row.runId ? ` run=${row.runId.slice(0, 8)}` : "";
    console.log(`${time} [${row.level}]${scope} ${row.type} ${JSON.stringify(row.payload)}`);
  }
}
