import { eq } from "drizzle-orm";
import { newId } from "@exec/core";
import { policies, type Db } from "@exec/db";
import { SEED_POLICIES } from "./seeds.js";

/**
 * Keep the built-in policies in sync with the code, on every process that
 * opens the database — not just once into an empty table.
 *
 * A one-time seed sounds right until the seed itself needs a fix: a real HARD
 * policy shipped with a pattern that silently failed to catch the exact thing
 * it was written for (git -C <path> push origin main slipping past a "no push
 * to main" denial), and a table-is-empty-only seed means that fix would only
 * ever reach a brand-new database — every already-running install stays
 * vulnerable until someone deletes their database by hand. Built-in policies
 * are matched by title and brought back in line with the current code every
 * time; anything whose title doesn't match a current built-in is left
 * completely alone (a genuinely custom policy, or one intentionally detached
 * by renaming it — there is no per-policy "don't sync me" flag yet, so
 * renaming is the only way to opt a built-in out of this today).
 *
 * Lives in `@exec/policy` rather than any one app because every process that
 * can open the database — the CLI, and now the daemon — needs the same fix
 * to reach it the moment it starts, not just whichever app happened to run
 * first.
 */
export function reconcileSeedPolicies(db: Db): void {
  const existing = db.select().from(policies).all();
  const byTitle = new Map(existing.map((p) => [p.title, p] as const));
  const now = Date.now();

  let updated = 0;
  for (const seed of SEED_POLICIES) {
    const row = byTitle.get(seed.title);
    if (!row) continue;
    const changed =
      JSON.stringify(row.matcher) !== JSON.stringify(seed.matcher) ||
      row.severity !== seed.severity ||
      row.action !== seed.action ||
      row.rationale !== seed.rationale;
    if (!changed) continue;
    db.update(policies)
      .set({
        matcher: seed.matcher,
        severity: seed.severity,
        action: seed.action,
        rationale: seed.rationale,
      })
      .where(eq(policies.id, row.id))
      .run();
    updated++;
  }
  if (updated > 0) {
    console.log(`Updated ${updated} built-in polic${updated === 1 ? "y" : "ies"} to the current definition.`);
  }

  const missing = SEED_POLICIES.filter((seed) => !byTitle.has(seed.title));
  if (missing.length === 0) return;
  let nextKeyNum = existing.length + 1;
  for (const seed of missing) {
    db.insert(policies)
      .values({
        id: newId(),
        key: `POLICY-${String(nextKeyNum++).padStart(3, "0")}`,
        ...seed,
        createdAt: now,
      })
      .run();
  }
  console.log(`Added ${missing.length} new built-in polic${missing.length === 1 ? "y" : "ies"}.`);
}
