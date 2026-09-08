import { describe, expect, it } from "vitest";
import { clampParkDelay } from "./engine.js";

describe("clampParkDelay", () => {
  it("falls back to a default when no hint is given", () => {
    expect(clampParkDelay(undefined)).toBe(60_000);
  });

  it("falls back to the default for a non-finite hint", () => {
    expect(clampParkDelay(Number.NaN)).toBe(60_000);
    expect(clampParkDelay(Number.POSITIVE_INFINITY)).toBe(60_000);
  });

  it("floors an unreasonably short hint so the daemon never hammers the API", () => {
    expect(clampParkDelay(500)).toBe(30_000);
    expect(clampParkDelay(0)).toBe(30_000);
  });

  it("caps an unreasonably long hint so the daemon still checks back periodically", () => {
    expect(clampParkDelay(6 * 60 * 60_000)).toBe(30 * 60_000);
  });

  it("passes through a hint already inside the sane window", () => {
    expect(clampParkDelay(5 * 60_000)).toBe(5 * 60_000);
  });
});
