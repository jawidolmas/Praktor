import { describe, expect, it } from "vitest";
import { extractSentence, parseArgs, parseCheck, readRunOptions } from "./args.js";

describe("parseArgs", () => {
  it("puts the sentence in positional regardless of where flags sit around it", () => {
    // The exact bug: `do --repo X "sentence"` treated "--repo" itself as the
    // sentence, because the old parser assumed argv[0] always was it.
    const before = parseArgs(["--repo", "C:\\repo", "add test.md"]);
    expect(extractSentence(before.positional)).toBe("add test.md");
    expect(before.flags.get("repo")).toEqual(["C:\\repo"]);

    const after = parseArgs(["add test.md", "--repo", "C:\\repo"]);
    expect(extractSentence(after.positional)).toBe("add test.md");
    expect(after.flags.get("repo")).toEqual(["C:\\repo"]);
  });

  it("collects repeated flags in order", () => {
    const { flags } = parseArgs(["--check", "a=1", "--check", "b=2"]);
    expect(flags.get("check")).toEqual(["a=1", "b=2"]);
  });

  it("treats a flag with no following value, or one followed by another flag, as boolean true", () => {
    const { flags } = parseArgs(["--verbose", "--effort", "high"]);
    expect(flags.get("verbose")).toEqual(["true"]);
    expect(flags.get("effort")).toEqual(["high"]);
  });

  it("joins multiple leftover positional tokens with a space, in order", () => {
    // An unquoted sentence gets split by the shell into several argv entries;
    // flags interspersed within it should not corrupt the reconstructed order.
    const { positional } = parseArgs(["add", "--repo", "X", "test.md", "please"]);
    expect(extractSentence(positional)).toBe("add test.md please");
  });
});

describe("extractSentence", () => {
  it("returns undefined for no leftover positional args", () => {
    expect(extractSentence([])).toBeUndefined();
    expect(extractSentence(["   "])).toBeUndefined();
  });
});

describe("parseCheck", () => {
  it("splits label=command on the first equals sign", () => {
    expect(parseCheck("tests=npm test")).toMatchObject({ label: "tests", command: "npm test" });
  });

  it("uses the whole string as both label and command when there is no equals sign", () => {
    expect(parseCheck("npm test")).toMatchObject({ label: "npm test", command: "npm test" });
  });
});

describe("readRunOptions", () => {
  it("applies documented defaults when nothing is set", () => {
    const opts = readRunOptions(new Map());
    expect(opts).toMatchObject({
      model: "claude-sonnet-5",
      effort: "high",
      baseRef: "HEAD",
      maxAttempts: 3,
      maxTurns: 30,
      maxWallClockMs: 20 * 60_000,
    });
  });

  it("honours explicit overrides", () => {
    const flags = new Map([
      ["model", ["claude-opus-5"]],
      ["max-turns", ["5"]],
    ]);
    const opts = readRunOptions(flags);
    expect(opts.model).toBe("claude-opus-5");
    expect(opts.maxTurns).toBe(5);
  });
});
