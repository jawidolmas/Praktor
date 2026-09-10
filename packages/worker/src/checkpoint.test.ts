import { describe, expect, it } from "vitest";
import { buildCheckpoint } from "./checkpoint.js";

const BASE = {
  taskTitle: "Add isEven helper",
  intent: "Add an isEven(n) function to math.js",
  filesChanged: ["math.js"],
  ruledOut: ["editing the wrong file"],
};

describe("buildCheckpoint", () => {
  it("treats a decision timeout as a pause, not a failed approach", () => {
    const checkpoint = buildCheckpoint({
      ...BASE,
      stallSignal: {
        signal: "decision_timeout",
        detail: "Unanswered: Which database for the new service?",
        decisionKey: "DEC-006",
      },
    });

    expect(checkpoint.currentProblem).toBe("Paused: Unanswered: Which database for the new service?");
    // Nothing to rule out — the worker correctly asked a question and got no
    // answer in time. Telling a respawned worker to avoid "whatever led to"
    // that would wrongly discourage it from ever asking again.
    expect(checkpoint.doNotRepeat).toEqual(BASE.ruledOut);
    expect(checkpoint.attemptsTried).toEqual([]);
  });

  it("still records an ordinary stall as a ruled-out approach", () => {
    const checkpoint = buildCheckpoint({
      ...BASE,
      stallSignal: { signal: "no_churn", detail: "5 turns with no file changes" },
    });

    expect(checkpoint.currentProblem).toBe("Stalled: 5 turns with no file changes");
    expect(checkpoint.doNotRepeat).toContain("Whatever led to: no_churn — 5 turns with no file changes");
    expect(checkpoint.attemptsTried).toHaveLength(1);
  });

  it("falls back to a generic problem statement with no stall or failed verify", () => {
    const checkpoint = buildCheckpoint(BASE);
    expect(checkpoint.currentProblem).toBe("The previous attempt did not reach a verified done state.");
  });
});
