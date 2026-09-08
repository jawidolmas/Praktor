import type { EventPayload } from "@exec/core";

/**
 * Turn an event payload into one line of live terminal output, or undefined
 * for events that shouldn't interrupt the stream (already printed elsewhere,
 * e.g. verify checks, or not interesting on their own, e.g. a bare turn
 * marker with no tool call or text in it).
 *
 * Kept separate from run.ts so the mapping from "thing that happened" to
 * "line a person reads live" is one pure, testable function rather than
 * console.log calls scattered across the supervisor loop.
 */

function truncate(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

export function formatLiveLine(payload: EventPayload): string | undefined {
  switch (payload.type) {
    case "run.message":
      return `  " ${truncate(payload.text, 240)}`;

    case "policy.evaluated": {
      const where = payload.target ? `: ${truncate(payload.target, 100)}` : "";
      if (payload.action === "deny") {
        return `  [denied] ${payload.tool}${where} (${payload.policyKey})`;
      }
      if (payload.action === "ask") {
        return `  [needs decision] ${payload.tool}${where} (${payload.policyKey})`;
      }
      if (payload.action === "warn") {
        return `  [warn] ${payload.tool}${where} — ${payload.reason}`;
      }
      return `  -> ${payload.tool}${where}`;
    }

    case "run.tool_result":
      return payload.isError
        ? `  [tool error] ${payload.tool}${payload.errorSignature ? `: ${truncate(payload.errorSignature, 100)}` : ""}`
        : undefined;

    case "stall.detected":
      return `  [stalled] ${payload.signal}${payload.detail ? `: ${payload.detail}` : ""}`;

    case "ratelimit.hit":
      return "  [rate limited] pausing this attempt";

    default:
      return undefined;
  }
}
