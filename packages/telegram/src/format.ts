import type { InlineButton } from "./client.js";

/**
 * Presentation logic kept pure and separate from the API client so it's
 * cheap to unit test without a real bot. Deliberately not dependent on
 * @exec/core's `Decision` row shape — only the handful of fields a
 * notification actually needs, so this package doesn't have to track every
 * column the decisions table grows over time.
 */

export interface DecisionOptionNotice {
  id: string;
  label: string;
  pros: string[];
  cons: string[];
}

export interface DecisionNotice {
  key: string;
  title: string;
  context: string;
  options: DecisionOptionNotice[];
  recommendation: string;
  risk: "low" | "medium" | "high";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatDecisionMessage(d: DecisionNotice): string {
  const lines: string[] = [
    `<b>Decision needed — ${escapeHtml(d.key)}</b>`,
    escapeHtml(d.title),
    "",
    escapeHtml(d.context),
    "",
  ];
  for (const opt of d.options) {
    const flag = opt.id === d.recommendation ? " (recommended)" : "";
    lines.push(`<b>[${escapeHtml(opt.id)}]</b> ${escapeHtml(opt.label)}${flag}`);
    for (const p of opt.pros) lines.push(`   + ${escapeHtml(p)}`);
    for (const c of opt.cons) lines.push(`   - ${escapeHtml(c)}`);
  }
  lines.push("");
  lines.push(`Risk: ${d.risk}`);
  return lines.join("\n");
}

/** One row of buttons, one per option, encoding the decision key and option
 *  id directly in `callback_data` — a tap is unambiguous, unlike matching a
 *  free-text reply against whichever decisions happen to be open. */
export function decisionKeyboard(d: DecisionNotice): InlineButton[][] {
  return [
    d.options.map((o) => ({
      text: o.id === d.recommendation ? `${o.id} ★` : o.id,
      callback_data: `dec:${d.key}:${o.id}`,
    })),
  ];
}

/** The inverse of `decisionKeyboard`'s callback_data — undefined for
 *  anything that isn't one of our own buttons (a stray tap, a stale
 *  keyboard from a previous bot version, etc.). */
export function parseDecisionCallback(
  data: string,
): { key: string; optionId: string } | undefined {
  const match = /^dec:([^:]+):(.+)$/.exec(data);
  if (!match) return undefined;
  const [, key, optionId] = match;
  if (!key || !optionId) return undefined;
  return { key, optionId };
}

export function formatAnsweredSuffix(optionId: string, answeredBy: string): string {
  return `\n\n✅ Answered: ${optionId} (by ${answeredBy})`;
}

/** One task the mechanical recovery loop or the classifier actually had to
 *  do something about, that reached "done" anyway — see `recoveredTasksSince`
 *  in @exec/db. This is what turns "Claude fucked up" into "Praktor detected
 *  the worker was failing and recovered": a concrete, named instance, not a
 *  claimed capability. */
export interface RecoveredItem {
  taskTitle: string;
  cause: string;
  class: string;
}

/** An open decision, with the recommendation resolved to its actual option
 *  label (e.g. "PostgreSQL + RLS") rather than a bare id — what makes this
 *  worth reading over just "1 objective blocked." */
export interface DecisionSummary {
  key: string;
  title: string;
  recommendationLabel: string;
}

/** See `approximateHealthSince` in @exec/db for exactly what these are (and
 *  are not) — best-effort proxies from real events, not a CI/security tool's
 *  actual score. `undefined` means no data in the window, not 0%. */
export interface HealthApprox {
  buildPct: number | undefined;
  testsPct: number | undefined;
  securityPct: number | undefined;
}

/** What the once-a-day digest reports: not just "here's what's pending" but
 *  a reason to actually open the message even on a quiet day — the whole
 *  point of a standing morning check-in rather than only escalating on a
 *  decision. */
export interface DigestSnapshot {
  finishedSinceLast: string[];
  active: string[];
  blocked: string[];
  parked: string[];
  recovered: RecoveredItem[];
  decisionsNeeded: DecisionSummary[];
  readyToMerge: string[];
  health: HealthApprox;
}

function healthBar(pct: number | undefined): string {
  if (pct === undefined) return "n/a";
  const filled = Math.round(pct / 10);
  return `${"█".repeat(filled)}${"░".repeat(10 - filled)} ${pct}%`;
}

/** Above this, a section stops being a quick morning read and starts being
 *  a wall of text — found live: an unbounded "ready to merge" list pulled in
 *  every never-merged objective going back days and swallowed the message.
 *  Each section still reports its true count via the "+N more" line, so
 *  nothing is silently hidden, just not dumped in full into a chat message. */
const MAX_ITEMS_PER_SECTION = 5;

export function formatDigestMessage(snapshot: DigestSnapshot): string {
  const lines: string[] = ["<b>Praktor Morning Brief</b>", ""];
  const section = (label: string, items: string[]): void => {
    lines.push(`<b>${label}</b>`);
    if (items.length === 0) {
      lines.push("   (none)");
    } else {
      for (const item of items.slice(0, MAX_ITEMS_PER_SECTION)) lines.push(`   • ${escapeHtml(item)}`);
      if (items.length > MAX_ITEMS_PER_SECTION) {
        lines.push(`   … +${items.length - MAX_ITEMS_PER_SECTION} more (see the dashboard)`);
      }
    }
    lines.push("");
  };

  section("Finished since last digest", snapshot.finishedSinceLast);

  lines.push("<b>Recovered automatically</b>");
  if (snapshot.recovered.length === 0) {
    lines.push("   (none)");
  } else {
    for (const r of snapshot.recovered.slice(0, MAX_ITEMS_PER_SECTION)) {
      lines.push(`   🔧 ${escapeHtml(r.taskTitle)} — ${escapeHtml(r.class)}: ${escapeHtml(r.cause)}`);
    }
    if (snapshot.recovered.length > MAX_ITEMS_PER_SECTION) {
      lines.push(`   … +${snapshot.recovered.length - MAX_ITEMS_PER_SECTION} more (see the dashboard)`);
    }
  }
  lines.push("");

  lines.push("<b>Decision needed</b>");
  if (snapshot.decisionsNeeded.length === 0) {
    lines.push("   (none)");
  } else {
    for (const d of snapshot.decisionsNeeded.slice(0, MAX_ITEMS_PER_SECTION)) {
      lines.push(`   ⚠ ${escapeHtml(d.title)} [${escapeHtml(d.key)}]`);
      lines.push(`      My recommendation: ${escapeHtml(d.recommendationLabel)}`);
    }
    if (snapshot.decisionsNeeded.length > MAX_ITEMS_PER_SECTION) {
      lines.push(`   … +${snapshot.decisionsNeeded.length - MAX_ITEMS_PER_SECTION} more (see the dashboard)`);
    }
  }
  lines.push("");

  section("Still running", snapshot.active);
  section("Paused (rate limit)", snapshot.parked);
  section("Ready to review & merge", snapshot.readyToMerge);

  lines.push("<b>Approximate health</b> (best effort — not a real build/test/security run)");
  lines.push(`   Build     ${healthBar(snapshot.health.buildPct)}`);
  lines.push(`   Tests     ${healthBar(snapshot.health.testsPct)}`);
  lines.push(`   Security  ${healthBar(snapshot.health.securityPct)}`);
  lines.push("");

  lines.push(
    snapshot.decisionsNeeded.length === 0
      ? "No urgent action required."
      : `${snapshot.decisionsNeeded.length} decision(s) need you.`,
  );

  return lines.join("\n").trimEnd();
}
