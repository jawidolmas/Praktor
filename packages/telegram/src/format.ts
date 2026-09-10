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

/** What the once-a-day digest reports: not just "here's what's pending" but
 *  a reason to actually open the message even on a quiet day — the whole
 *  point of a standing morning check-in rather than only escalating on a
 *  decision. */
export interface DigestSnapshot {
  finishedSinceLast: string[];
  active: string[];
  blocked: string[];
  parked: string[];
}

export function formatDigestMessage(snapshot: DigestSnapshot): string {
  const lines: string[] = ["<b>Morning digest</b>", ""];
  const section = (label: string, items: string[]): void => {
    lines.push(`<b>${label}</b>`);
    if (items.length === 0) {
      lines.push("   (none)");
    } else {
      for (const item of items) lines.push(`   • ${escapeHtml(item)}`);
    }
    lines.push("");
  };
  section("Finished since last digest", snapshot.finishedSinceLast);
  section("Still running", snapshot.active);
  section("Waiting on you", snapshot.blocked);
  section("Paused (rate limit)", snapshot.parked);
  return lines.join("\n").trimEnd();
}
