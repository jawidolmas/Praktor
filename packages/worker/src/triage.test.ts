import { describe, expect, it } from "vitest";
import { buildTriagePrompt, quickTriage } from "./triage.js";

describe("quickTriage — free, no model call", () => {
  it("answers the commonest acknowledgements without starting work", () => {
    for (const m of ["Thanks", "thank you!", "Great work!!", "ok", "Thanks Praktor", "good job.", "👍", "LGTM"]) {
      const t = quickTriage(m);
      expect(t?.kind, m).toBe("chat");
      expect(t?.reply?.length).toBeGreaterThan(10);
    }
  });

  it("leaves anything that might be a request to the real check", () => {
    for (const m of ["thanks, now add tests", "add a README", "ok fix the login bug", "great, also update the docs", ""]) {
      expect(quickTriage(m), m).toBeUndefined();
    }
  });

  it("gives the same reply to the same message", () => {
    expect(quickTriage("thanks")?.reply).toBe(quickTriage("Thanks!")?.reply);
  });
});

describe("buildTriagePrompt", () => {
  it("leans to task when in doubt, and includes the conversation", () => {
    const p = buildTriagePrompt("now make it faster", "clarus", ["add a parser"]);
    expect(p).toContain("When in doubt between task and anything else, choose task");
    expect(p).toContain("1. add a parser");
    expect(p).toContain('"clarus"');
  });
});
