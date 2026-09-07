import type { Policy } from "@exec/core";
import { evaluate, type PolicyVerdict, type ToolCall } from "./engine.js";

/**
 * Adapter from a policy verdict to the Claude Agent SDK PreToolUse hook output.
 *
 * This is the enforcement point. Returning `deny` here stops the tool call in the
 * harness, so a HARD policy holds regardless of what the worker intends.
 */

export interface PreToolUseHookOutput {
  systemMessage?: string;
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny" | "ask";
    permissionDecisionReason: string;
  };
}

export function verdictToHookOutput(
  verdict: PolicyVerdict,
): PreToolUseHookOutput {
  // `warn` is advisory: the call proceeds, but the worker is told why it was noted.
  const permissionDecision =
    verdict.action === "warn" ? "allow" : verdict.action;

  const output: PreToolUseHookOutput = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason: verdict.reason,
    },
  };

  if (verdict.action === "warn") {
    output.systemMessage = `Policy note — ${verdict.reason}`;
  }
  if (verdict.action === "deny") {
    output.systemMessage =
      `Blocked by ${verdict.policy?.key ?? "policy"}. ` +
      `Do not attempt this again or work around it. If you believe the task genuinely ` +
      `requires it, call request_decision to escalate instead.`;
  }

  return output;
}

export interface PolicyHookOptions {
  loadPolicies: () => Policy[];
  onVerdict?: (call: ToolCall, verdict: PolicyVerdict) => void;
}

/**
 * Build the in-process PreToolUse callback handed to every worker.
 *
 * Policies are loaded per call rather than captured once, so tightening a policy
 * takes effect on the very next tool call of an already-running worker.
 */
export function createPolicyHook(options: PolicyHookOptions) {
  return (call: ToolCall): PreToolUseHookOutput => {
    const verdict = evaluate(options.loadPolicies(), call);
    options.onVerdict?.(call, verdict);
    return verdictToHookOutput(verdict);
  };
}
