import { deleteMemory, listMemories, openDb, runMigrations, upsertMemory } from "@exec/db";

/**
 * The standing engineering profile (permanent-tier memory) — CLI-only for
 * now, no dashboard editor. This is what `apps/daemon/src/plan.ts` and
 * `engine.ts` read into every planner/worker/judge/diagnoser call, so
 * setting an entry here has an immediate, real effect on the next objective
 * submitted, not just on a display somewhere.
 */

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

export function printProfileList(): void {
  const { db } = openDb();
  runMigrations(db);

  const entries = listMemories(db, "permanent");
  if (entries.length === 0) {
    console.log(
      'No engineering profile set yet. Add one with:\n  exec-agent profile set --title "Architecture" ' +
        '--value "Prefer simple systems, avoid unnecessary abstractions."',
    );
    return;
  }

  for (const entry of entries) {
    console.log(`${pad(entry.title, 20)}${entry.content}`);
  }
}

export function setProfileEntry(title: string | undefined, value: string | undefined): void {
  if (!title || !value) {
    console.error('usage: exec-agent profile set --title "<category>" --value "<preference>"');
    process.exitCode = 1;
    return;
  }

  const { db } = openDb();
  runMigrations(db);
  upsertMemory(db, { tier: "permanent", title, content: value, source: "cli" });
  console.log(`Set "${title}": ${value}`);
}

export function unsetProfileEntry(title: string | undefined): void {
  if (!title) {
    console.error('usage: exec-agent profile unset "<category>"');
    process.exitCode = 1;
    return;
  }

  const { db } = openDb();
  runMigrations(db);
  const removed = deleteMemory(db, "permanent", "", title);
  console.log(removed ? `Removed "${title}".` : `No profile entry named "${title}".`);
}
