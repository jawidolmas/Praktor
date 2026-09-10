import { describe, expect, it } from "vitest";
import { renderDecisionPdf, type DecisionPacketArgs } from "./decision-pdf.js";

const ARGS: DecisionPacketArgs = {
  objectiveTitle: "Ship the notifications feature",
  taskTitle: "Add a Telegram bridge",
  intent: "Push decisions to Telegram and answer them from there.",
  decisionKey: "DEC-006",
  decisionTitle: "Which database for the new service?",
  decisionContext: "Blocks setting up persistence for the notifications feature.",
  options: [
    { id: "A", label: "SQLite", pros: ["zero ops"], cons: ["single writer"] },
    { id: "B", label: "Postgres", pros: ["scales later"], cons: ["needs a hosted instance"] },
  ],
  recommendation: "A",
  risk: "low",
  filesChangedSoFar: ["apps/daemon/src/telegram-bridge.ts"],
};

describe("renderDecisionPdf", () => {
  it("produces a well-formed PDF", async () => {
    const bytes = await renderDecisionPdf(ARGS);
    expect(bytes.length).toBeGreaterThan(0);
    // The PDF file-format magic bytes — the cheapest real check that this is
    // actually a PDF and not, say, an empty or truncated buffer.
    expect(Buffer.from(bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-");
  });

  it("does not throw when there are no options, no files, or very long text", async () => {
    const bytes = await renderDecisionPdf({
      ...ARGS,
      options: [
        { id: "A", label: "Do nothing", pros: [], cons: [] },
        { id: "B", label: "x".repeat(500), pros: ["y".repeat(300)], cons: [] },
      ],
      filesChangedSoFar: [],
      decisionContext: "z ".repeat(400),
    });
    expect(Buffer.from(bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-");
  });
});
