import { describe, expect, it } from "vitest";
import { describeEvent } from "./format.js";

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

describe("describeEvent", () => {
  it("renders every event type without throwing (exhaustiveness)", () => {
    const samples: Parameters<typeof describeEvent>[0][] = [
      { type: "objective.created", title: "t", repoPath: "/r" },
      { type: "objective.status_changed", from: "active", to: "done" },
      { type: "task.created", key: "T-001", title: "t", dependsOn: [] },
      { type: "task.status_changed", from: "pending", to: "running" },
      { type: "run.started", sessionId: "s", model: "m", worktreePath: "/w", attempt: 1, seededFromCheckpoint: false },
      { type: "run.turn", turn: 1, usage: ZERO_USAGE },
      { type: "run.message", text: "hi" },
      { type: "run.tool_result", tool: "Bash", isError: false },
      { type: "run.finished", exitReason: "completed", turns: 1, usage: ZERO_USAGE, costUsdEstimate: 0, durationMs: 10 },
      { type: "stall.detected", signal: "no_churn", detail: "" },
      { type: "checkpoint.written", artifactId: "a", ruledOutCount: 1 },
      { type: "policy.evaluated", policyKey: "-", tool: "Bash", action: "allow", reason: "" },
      { type: "verify.check", label: "tests", command: "npm test", exitCode: 0, passed: true, durationMs: 1 },
      { type: "verify.result", passed: true, failedLabels: [] },
      { type: "decision.raised", key: "DEC-001", level: "L2", title: "t", blockedTaskIds: [] },
      { type: "decision.answered", key: "DEC-001", answer: "A", answeredBy: "op" },
      { type: "ratelimit.hit", source: "result" },
      { type: "ratelimit.cleared", parkedMs: 1000 },
      { type: "brain.call", site: "decompose", ok: true, durationMs: 5 },
      { type: "finding.recorded", title: "t", detail: "" },
      { type: "run.progress", milestone: "m", detail: "" },
      { type: "note", message: "n" },
      { type: "objective.approved", branch: "exec/abc-attempt-1", baseRef: "main", pushed: true, approvedBy: "dashboard" },
    ];
    for (const payload of samples) {
      const display = describeEvent(payload);
      expect(display.text.length).toBeGreaterThan(0);
      expect(["info", "success", "warn", "error", "muted"]).toContain(display.kind);
    }
  });

  it("marks a policy denial as an error and includes the target and key", () => {
    const display = describeEvent({
      type: "policy.evaluated",
      policyKey: "POLICY-001",
      tool: "Bash",
      action: "deny",
      reason: "no direct push to main",
      target: "git push origin main",
    });
    expect(display.kind).toBe("error");
    expect(display.text).toBe("Denied — Bash: git push origin main (POLICY-001)");
  });

  it("marks a failed acceptance check as an error and a passed one as success", () => {
    const passed = describeEvent({
      type: "verify.check",
      label: "tests",
      command: "npm test",
      exitCode: 0,
      passed: true,
      durationMs: 250,
    });
    expect(passed.kind).toBe("success");
    expect(passed.text).toContain("[PASS]");

    const failed = describeEvent({
      type: "verify.check",
      label: "tests",
      command: "npm test",
      exitCode: 1,
      passed: false,
      durationMs: 250,
    });
    expect(failed.kind).toBe("error");
    expect(failed.text).toContain("[FAIL]");
  });

  it("truncates long assistant messages", () => {
    const long = "x".repeat(500);
    const display = describeEvent({ type: "run.message", text: long });
    expect(display.text.length).toBeLessThan(410);
    expect(display.text.endsWith("…")).toBe(true);
  });
});
