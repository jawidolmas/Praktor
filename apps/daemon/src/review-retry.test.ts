import { describe, expect, it } from "vitest";
import { reviewWithRetry } from "./review-retry.js";

const noSleep = async () => {};

describe("reviewWithRetry", () => {
  it("returns the first successful verdict", async () => {
    const result = await reviewWithRetry(async () => "accept", { sleep: noSleep });
    expect(result).toEqual({ ok: true, value: "accept", failures: [] });
  });

  it("retries a transient failure and keeps what went wrong", async () => {
    let calls = 0;
    const result = await reviewWithRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("The reviewer finished without calling submit_review.");
        return "accept";
      },
      { sleep: noSleep },
    );
    expect(result).toEqual({
      ok: true,
      value: "accept",
      failures: ["The reviewer finished without calling submit_review."],
    });
  });

  it("gives up after the attempt budget, reporting every failure", async () => {
    let calls = 0;
    const result = await reviewWithRetry(
      async () => {
        calls += 1;
        throw new Error(`boom ${calls}`);
      },
      { attempts: 3, sleep: noSleep },
    );
    expect(calls).toBe(3);
    expect(result).toEqual({ ok: false, failures: ["boom 1", "boom 2", "boom 3"] });
  });

  it("pauses between tries, longer each time, but not after the last", async () => {
    const pauses: number[] = [];
    await reviewWithRetry(
      async () => {
        throw new Error("x");
      },
      { attempts: 3, sleep: async (ms) => void pauses.push(ms) },
    );
    expect(pauses).toEqual([5_000, 10_000]);
  });
});
