import { listObjectives, openDb, runMigrations } from "@exec/db";
import { reconcileSeedPolicies } from "@exec/policy";

/** How long ago, in the coarsest unit that still reads naturally — "come back
 *  in three days" needs "2d ago," not a raw timestamp you have to do the
 *  subtraction on yourself. */
function relativeTime(ms: number): string {
  const deltaMs = Date.now() - ms;
  const deltaSec = Math.floor(deltaMs / 1000);
  if (deltaSec < 60) return "just now";
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHour = Math.floor(deltaMin / 60);
  if (deltaHour < 24) return `${deltaHour}h ago`;
  const deltaDay = Math.floor(deltaHour / 24);
  return `${deltaDay}d ago`;
}

function truncate(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/**
 * Every objective the supervisor knows about, newest first — the entry point
 * for "what's outstanding" that doesn't require already knowing an id. Every
 * other objective-scoped command (`events`, `watch`, `decide`, `approve`,
 * `abandon`) needs one; without this, a terminal-only user with no dashboard
 * running has no way to rediscover an id they didn't write down, which
 * defeats "walk away and check back later."
 */
export function printObjectiveList(statusFilter?: string): void {
  const { db } = openDb();
  runMigrations(db);
  reconcileSeedPolicies(db);

  const all = listObjectives(db);
  const rows = statusFilter ? all.filter((o) => o.status === statusFilter) : all;

  if (rows.length === 0) {
    console.log(statusFilter ? `No objectives with status "${statusFilter}".` : "No objectives yet.");
    return;
  }

  console.log(`${pad("ID", 10)}${pad("STATUS", 11)}${pad("TASKS", 7)}${pad("UPDATED", 10)}TITLE`);
  for (const o of rows) {
    const id = o.id.slice(0, 8);
    const tasks = o.taskCount > 0 ? `${o.doneTaskCount}/${o.taskCount}` : "-";
    const updated = relativeTime(o.lastEventAt ?? o.updatedAt);
    console.log(`${pad(id, 10)}${pad(o.status, 11)}${pad(tasks, 7)}${pad(updated, 10)}${truncate(o.title, 70)}`);
  }
  console.log(`\n${rows.length} objective(s). Use "exec-agent events <id>" or "exec-agent watch <id>" for detail.`);
}
