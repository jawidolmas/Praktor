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

describe("formatDigestMessage", () => {
  it("lists every section, marking an empty one rather than omitting it", () => {
    const msg = formatDigestMessage({
      finishedSinceLast: ["Ship the notifications feature (done)"],
      active: ["Add a Telegram bridge"],
      blocked: [],
      parked: [],
    });
    expect(msg).toContain("Finished since last digest");
    expect(msg).toContain("Ship the notifications feature (done)");
    expect(msg).toContain("Add a Telegram bridge");
    expect(msg).toContain("Waiting on you");
    expect(msg).toContain("(none)");
  });

  it("still produces a message when everything is empty", () => {
    const msg = formatDigestMessage({ finishedSinceLast: [], active: [], blocked: [], parked: [] });
    expect(msg).toContain("Morning digest");
    expect((msg.match(/\(none\)/g) ?? []).length).toBe(4);
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
