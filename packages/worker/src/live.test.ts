import { describe, expect, it } from "vitest";
import type { EventPayload } from "@exec/core";
import { formatLiveLine } from "./live.js";

describe("formatLiveLine", () => {
  it("renders assistant text, collapsing whitespace and truncating long text", () => {
    const line = formatLiveLine({ type: "run.message", text: "line one\n\nline two" });
    expect(line).toBe('  " line one line two');

    const long = "x".repeat(300);
    const truncated = formatLiveLine({ type: "run.message", text: long });
    expect(truncated?.length).toBeLessThan(260);
    expect(truncated?.endsWith("…")).toBe(true);
  });

  it("renders an allowed tool call with its target", () => {
    const line = formatLiveLine({
      type: "policy.evaluated",
      policyKey: "-",
      tool: "Bash",
      action: "allow",
      reason: "no policy matched",
      target: "git status",
    });
    expect(line).toBe("  -> Bash: git status");
  });

  it("renders an allowed call with no target (no command/path on the input)", () => {
    const line = formatLiveLine({
      type: "policy.evaluated",
      policyKey: "-",
      tool: "TodoWrite",
      action: "allow",
      reason: "no policy matched",
    });
    expect(line).toBe("  -> TodoWrite");
  });

  it("flags a denial with the policy key", () => {
    const line = formatLiveLine({
      type: "policy.evaluated",
      policyKey: "POLICY-001",
      tool: "Bash",
      action: "deny",
      reason: "no direct push to main",
      target: "git push origin main",
    });
    expect(line).toBe("  [denied] Bash: git push origin main (POLICY-001)");
  });

  it("flags an ask verdict distinctly from a denial", () => {
    const line = formatLiveLine({
      type: "policy.evaluated",
      policyKey: "POLICY-003",
      tool: "Bash",
      action: "ask",
      reason: "destructive SQL",
      target: "drop table users",
    });
    expect(line).toBe("  [needs decision] Bash: drop table users (POLICY-003)");
  });

  it("flags a warn verdict with the reason instead of the policy key", () => {
    const line = formatLiveLine({
      type: "policy.evaluated",
      policyKey: "POLICY-006",
      tool: "Bash",
      action: "warn",
      reason: "installing a new dependency",
      target: "npm install left-pad",
    });
    expect(line).toBe("  [warn] Bash: npm install left-pad — installing a new dependency");
  });

  it("renders a failed tool result but not a successful one", () => {
    const failed = formatLiveLine({
      type: "run.tool_result",
      tool: "Bash",
      isError: true,
      errorSignature: "ENOENT",
    });
    expect(failed).toBe("  [tool error] Bash: ENOENT");

    const succeeded = formatLiveLine({ type: "run.tool_result", tool: "Bash", isError: false });
    expect(succeeded).toBeUndefined();
  });

  it("renders stall and rate-limit signals", () => {
    expect(formatLiveLine({ type: "stall.detected", signal: "no_churn", detail: "3 turns, 0 lines changed" })).toBe(
      "  [stalled] no_churn: 3 turns, 0 lines changed",
    );
    expect(formatLiveLine({ type: "ratelimit.hit", source: "result" })).toBe(
      "  [rate limited] pausing this attempt",
    );
  });

  it("stays silent for events already printed elsewhere or not worth a live line", () => {
    const quiet: EventPayload[] = [
      { type: "run.turn", turn: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } },
      {
        type: "run.finished",
        exitReason: "completed",
        turns: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        costUsdEstimate: 0,
        durationMs: 0,
      },
      { type: "verify.check", label: "tests", command: "npm test", exitCode: 0, passed: true, durationMs: 10 },
    ];
    for (const payload of quiet) {
      expect(formatLiveLine(payload)).toBeUndefined();
    }
  });
});
