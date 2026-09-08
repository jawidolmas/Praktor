import type { Policy, PolicyAction } from "@exec/core";

/**
 * The policy engine.
 *
 * A policy is a row, not a sentence in a prompt. This module turns a proposed tool
 * call into an allow/deny/ask verdict that the harness enforces via a PreToolUse
 * hook — the model's opinion is never consulted.
 */

export interface ToolCall {
  tool: string;
  input: unknown;
}

export interface PolicyVerdict {
  action: PolicyAction;
  /** The policy that produced a non-allow verdict, for the reason string and the log. */
  policy?: Policy;
  reason: string;
}

/** Most restrictive wins when several policies match. */
const PRECEDENCE: Record<PolicyAction, number> = {
  deny: 3,
  ask: 2,
  warn: 1,
  allow: 0,
};

/**
 * Pull the shell command out of a tool input.
 *
 * Both Bash and PowerShell tools carry the command under `command`; keeping this in
 * one place means a policy written for "Bash" style commands still sees the text
 * when a worker reaches for the other shell.
 */
export function extractCommand(call: ToolCall): string | undefined {
  const input = call.input;
  if (typeof input !== "object" || input === null) return undefined;
  const command = (input as Record<string, unknown>)["command"];
  return typeof command === "string" ? command : undefined;
}

/** Pull a file path out of a tool input, across the differing argument names. */
export function extractPath(call: ToolCall): string | undefined {
  const input = call.input;
  if (typeof input !== "object" || input === null) return undefined;
  const rec = input as Record<string, unknown>;
  for (const key of ["file_path", "path", "notebook_path", "filePath"]) {
    const v = rec[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

function matches(policy: Policy, call: ToolCall): boolean {
  const { matcher } = policy;

  if (matcher.tool && matcher.tool.toLowerCase() !== call.tool.toLowerCase()) {
    return false;
  }

  if (matcher.commandPattern) {
    const command = extractCommand(call);
    if (command === undefined) return false;
    // A string is one test; an array requires every pattern to match (AND) —
    // see the schema doc comment for why this matters for security policies.
    const patterns = Array.isArray(matcher.commandPattern)
      ? matcher.commandPattern
      : [matcher.commandPattern];
    for (const pattern of patterns) {
      if (!new RegExp(pattern, "i").test(command)) return false;
    }
  }

  if (matcher.pathPattern) {
    const path = extractPath(call);
    if (path === undefined) return false;
    // Normalise Windows separators so one pattern works on both platforms.
    if (!new RegExp(matcher.pathPattern, "i").test(path.replace(/\\/g, "/"))) {
      return false;
    }
  }

  // A matcher with no fields set would match every call; treat that as a
  // configuration error rather than silently governing everything.
  return Boolean(matcher.tool ?? matcher.commandPattern ?? matcher.pathPattern);
}

/**
 * Evaluate a tool call against the active policy set.
 *
 * An invalid regex in a policy fails closed for HARD policies: a rule that cannot be
 * evaluated must not silently permit the thing it was written to prevent.
 */
export function evaluate(policies: Policy[], call: ToolCall): PolicyVerdict {
  let winner: PolicyVerdict = { action: "allow", reason: "no policy matched" };

  for (const policy of policies) {
    if (!policy.enabled) continue;

    let hit: boolean;
    try {
      hit = matches(policy, call);
    } catch {
      if (policy.severity === "HARD") {
        return {
          action: "deny",
          policy,
          reason: `${policy.key}: policy could not be evaluated and is HARD, so the call is refused`,
        };
      }
      continue;
    }
    if (!hit) continue;

    if (PRECEDENCE[policy.action] > PRECEDENCE[winner.action]) {
      winner = {
        action: policy.action,
        policy,
        reason: `${policy.key}: ${policy.title}`,
      };
    }
  }

  return winner;
}
