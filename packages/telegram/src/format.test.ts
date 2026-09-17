import { describe, expect, it } from "vitest";
import {
  decisionKeyboard,
  formatDecisionMessage,
  formatDigestMessage,
  parseDecisionCallback,
  type DecisionNotice,
} from "./format.js";

const notice: DecisionNotice = {
  key: "DEC-024",
  title: "Pick a hosting provider",
  context: "Blocks deploying the API.",
  options: [
    { id: "A", label: "Fly.io", pros: ["cheap"], cons: ["less familiar"] },
    { id: "B", label: "AWS", pros: ["team knows it"], cons: ["more setup"] },
  ],
  recommendation: "B",
  risk: "medium",
};

describe("formatDecisionMessage", () => {
  it("includes the key, title, context, and every option with its pros/cons", () => {
    const msg = formatDecisionMessage(notice);
    expect(msg).toContain("DEC-024");
    expect(msg).toContain("Pick a hosting provider");
    expect(msg).toContain("Blocks deploying the API.");
    expect(msg).toContain("Fly.io");
    expect(msg).toContain("cheap");
    expect(msg).toContain("AWS (recommended)");
  });

  it("escapes HTML-significant characters so parse_mode: HTML can't break", () => {
    const msg = formatDecisionMessage({ ...notice, title: "<script>alert(1)</script>" });
    expect(msg).not.toContain("<script>");
    expect(msg).toContain("&lt;script&gt;");
  });
});

describe("decisionKeyboard", () => {
  it("emits one button per option with the decision key and option id encoded", () => {
    const rows = decisionKeyboard(notice);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual([
      { text: "A", callback_data: "dec:DEC-024:A" },
      { text: "B ★", callback_data: "dec:DEC-024:B" },
    ]);
  });
});

const EMPTY_DIGEST = {
  finishedSinceLast: [],
  active: [],
  blocked: [],
  parked: [],
  recovered: [],
  decisionsNeeded: [],
  readyToMerge: [],
  health: { buildPct: undefined, testsPct: undefined, securityPct: undefined },
};

describe("formatDigestMessage", () => {
  it("lists every section, marking an empty one rather than omitting it", () => {
    const msg = formatDigestMessage({
      ...EMPTY_DIGEST,
      finishedSinceLast: ["Ship the notifications feature (done)"],
      active: ["Add a Telegram bridge"],
    });
    expect(msg).toContain("Finished since last digest");
    expect(msg).toContain("Ship the notifications feature (done)");
    expect(msg).toContain("Add a Telegram bridge");
    expect(msg).toContain("(none)");
  });

  it("still produces a message when everything is empty, saying no urgent action is needed", () => {
    const msg = formatDigestMessage(EMPTY_DIGEST);
    expect(msg).toContain("Praktor Morning Brief");
    expect(msg).toContain("No urgent action required.");
    expect(msg).toContain("Build     n/a");
  });

  it("surfaces a recovered task's cause and class", () => {
    const msg = formatDigestMessage({
      ...EMPTY_DIGEST,
      recovered: [{ taskTitle: "Add isEven helper", cause: "turn budget too tight", class: "flaky" }],
    });
    expect(msg).toContain("Add isEven helper");
    expect(msg).toContain("flaky");
    expect(msg).toContain("turn budget too tight");
  });

  it("shows a decision's resolved recommendation label and flags it as urgent, not \"no action required\"", () => {
    const msg = formatDigestMessage({
      ...EMPTY_DIGEST,
      decisionsNeeded: [{ key: "DEC-001", title: "Database architecture", recommendationLabel: "PostgreSQL + RLS" }],
    });
    expect(msg).toContain("Database architecture");
    expect(msg).toContain("My recommendation: PostgreSQL + RLS");
    expect(msg).toContain("1 decision(s) need you.");
    expect(msg).not.toContain("No urgent action required.");
  });

  it("caps a long section instead of dumping everything into one message", () => {
    const msg = formatDigestMessage({
      ...EMPTY_DIGEST,
      readyToMerge: Array.from({ length: 26 }, (_, i) => `Objective ${i + 1}`),
    });
    expect((msg.match(/^   • /gm) ?? []).length).toBe(5);
    expect(msg).toContain("… +21 more (see the dashboard)");
  });

  it("renders a health percentage as a filled/empty bar, and leaves undefined as n/a", () => {
    const msg = formatDigestMessage({
      ...EMPTY_DIGEST,
      health: { buildPct: 100, testsPct: 90, securityPct: undefined },
    });
    expect(msg).toContain("Build     ██████████ 100%");
    expect(msg).toContain("Tests     █████████░ 90%");
    expect(msg).toContain("Security  n/a");
  });
});

describe("parseDecisionCallback", () => {
  it("round-trips what decisionKeyboard encodes", () => {
    const rows = decisionKeyboard(notice);
    const data = rows[0]?.[0]?.callback_data;
    expect(data).toBeDefined();
    expect(parseDecisionCallback(data as string)).toEqual({ key: "DEC-024", optionId: "A" });
  });

  it("returns undefined for data that isn't one of ours", () => {
    expect(parseDecisionCallback("something-else")).toBeUndefined();
    expect(parseDecisionCallback("dec:onlyone")).toBeUndefined();
  });
});
