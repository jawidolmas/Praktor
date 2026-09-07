import { describe, expect, it } from "vitest";
import {
  DEFAULT_STALL_CONFIG,
  detectStall,
  interpretRateLimit,
  normalizeError,
  type TurnSample,
} from "./telemetry.js";

const usage = (input: number) => ({
  input,
  output: 500,
  cacheRead: 0,
  cacheCreation: 0,
});

const sample = (over: Partial<TurnSample> & { turn: number }): TurnSample => ({
  usage: usage(1_000),
  toolCalls: [],
  errorSignatures: [],
  churn: 0,
  ...over,
});

/** A healthy run: tools are called and the working tree actually changes. */
const productive = (n: number): TurnSample[] =>
  Array.from({ length: n }, (_, i) =>
    sample({
      turn: i + 1,
      toolCalls: [{ tool: "Edit", targetPath: `src/f${i}.ts` }],
      churn: 20,
    }),
  );

const WINDOW = 200_000;

describe("normalizeError", () => {
  it("collapses the parts that vary between identical failures", () => {
    const a = normalizeError("Error at src/parser.ts:41:9 after 132ms (0xdeadbeef)");
    const b = normalizeError("Error at src/parser.ts:87:2 after 9ms (0xfeed)");
    expect(a).toBe(b);
  });

  it("keeps genuinely different errors distinct", () => {
    expect(normalizeError("cannot find module foo")).not.toBe(
      normalizeError("cannot find module bar"),
    );
  });
});

describe("detectStall", () => {
  const detect = (samples: TurnSample[], maxTurns = 100) =>
    detectStall({ samples, contextWindow: WINDOW, maxTurns });

  it("returns null while work is progressing", () => {
    expect(detect(productive(10))).toBeNull();
  });

  it("returns null with no samples yet", () => {
    expect(detect([])).toBeNull();
  });

  it("fires on context pressure before any behavioural signal", () => {
    const samples = productive(4);
    samples.push(sample({ turn: 5, usage: usage(WINDOW * 0.8), churn: 30 }));

    const signal = detect(samples);
    expect(signal?.signal).toBe("context_pressure");
    expect(signal?.detail).toMatch(/80%/);
  });

  it("counts cache reads toward context pressure, not just fresh input", () => {
    const samples = [
      sample({
        turn: 1,
        usage: { input: 1_000, output: 100, cacheRead: WINDOW * 0.79, cacheCreation: 0 },
      }),
    ];
    expect(detect(samples)?.signal).toBe("context_pressure");
  });

  it("fires when the same error keeps recurring", () => {
    const err = normalizeError("TypeError: cannot read x of undefined at a.ts:10:2");
    const samples = Array.from({ length: 3 }, (_, i) =>
      sample({ turn: i + 1, errorSignatures: [err], churn: 5 }),
    );

    const signal = detect(samples);
    expect(signal?.signal).toBe("repeat_error");
    expect(signal?.detail).toMatch(/3 times/);
  });

  it("tolerates the same error twice — that is a normal retry", () => {
    const err = normalizeError("boom at a.ts:1:1");
    const samples = Array.from({ length: 2 }, (_, i) =>
      sample({ turn: i + 1, errorSignatures: [err], churn: 5 }),
    );
    expect(detect(samples)).toBeNull();
  });

  it("fires when there is heavy tool use but nothing changes on disk", () => {
    const samples = Array.from({ length: DEFAULT_STALL_CONFIG.noChurnTurns }, (_, i) =>
      sample({
        turn: i + 1,
        toolCalls: [
          { tool: "Read", targetPath: "src/a.ts" },
          { tool: "Grep" },
        ],
        churn: 0,
      }),
    );

    const signal = detect(samples);
    expect(signal?.signal).toBe("no_churn");
  });

  it("does not mistake quiet reading for thrashing", () => {
    // Few tool calls and no churn is a worker orienting itself, not a stall.
    const samples = Array.from({ length: DEFAULT_STALL_CONFIG.noChurnTurns }, (_, i) =>
      sample({ turn: i + 1, toolCalls: [{ tool: "Read" }], churn: 0 }),
    );
    expect(detect(samples)).toBeNull();
  });

  it("fires when one file is rewritten repeatedly with no net change", () => {
    const samples = Array.from({ length: DEFAULT_STALL_CONFIG.noChurnTurns }, (_, i) =>
      sample({
        turn: i + 1,
        toolCalls: [{ tool: "Edit", targetPath: "src/parser.ts" }],
        churn: 0,
      }),
    );

    const signal = detect(samples);
    // Only 5 tool calls, so the churn detector stays quiet and this one speaks.
    expect(signal?.signal).toBe("file_thrash");
    expect(signal?.detail).toMatch(/src\/parser\.ts/);
  });

  it("fires when the turn budget is exhausted", () => {
    const signal = detect(productive(12), 12);
    expect(signal?.signal).toBe("turn_budget");
  });
});

describe("interpretRateLimit", () => {
  it("does not park while comfortably within limits", () => {
    expect(interpretRateLimit({ status: "allowed", utilization: 0.4 }).park).toBe(false);
  });

  it("keeps working through a warning that is not yet close to the wall", () => {
    expect(
      interpretRateLimit({ status: "allowed_warning", utilization: 0.6 }).park,
    ).toBe(false);
  });

  it("parks pre-emptively when utilisation is nearly exhausted", () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const verdict = interpretRateLimit({
      status: "allowed_warning",
      utilization: 0.97,
      resetsAt,
      rateLimitType: "five_hour",
    });

    expect(verdict.park).toBe(true);
    expect(verdict.reason).toMatch(/five_hour/);
    expect(verdict.resumeAt).toBe(resetsAt * 1000);
  });

  it("parks and resumes at the reset time when rejected", () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 60;
    const verdict = interpretRateLimit({ status: "rejected", resetsAt });

    expect(verdict.park).toBe(true);
    expect(verdict.resumeAt).toBe(resetsAt * 1000);
  });

  it("falls back to a fixed wait when rejected with no reset time", () => {
    const before = Date.now();
    const verdict = interpretRateLimit({ status: "rejected" });

    expect(verdict.park).toBe(true);
    expect(verdict.resumeAt).toBeGreaterThanOrEqual(before + 15 * 60_000);
  });

  it("accepts a reset time already expressed in milliseconds", () => {
    const resetsAt = Date.now() + 3600_000;
    expect(interpretRateLimit({ status: "rejected", resetsAt }).resumeAt).toBe(resetsAt);
  });
});
