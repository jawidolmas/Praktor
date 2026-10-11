import type { EventPayload } from "@exec/core";

/**
 * Turn an event payload into something a browser renders, for every event
 * type — not just the subset worth interrupting a scrolling terminal for.
 * `@exec/worker`'s `formatLiveLine` is deliberately terse and silent on most
 * lifecycle events because it competes with a live-scrolling terminal; a
 * dashboard has a dedicated panel per objective, so it can afford to show all
 * of it. Kept as one pure function, mirroring that module, so the mapping is
 * unit-testable without a server or a browser.
 */

export type EventKind = "info" | "success" | "warn" | "error" | "muted";

export interface EventDisplay {
  kind: EventKind;
  text: string;
}

function truncate(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function fmtUsage(u: { input: number; output: number; cacheRead: number; cacheCreation: number }): string {
  const total = u.input + u.output + u.cacheRead + u.cacheCreation;
  return `${total.toLocaleString()} tokens`;
}

export function describeEvent(payload: EventPayload): EventDisplay {
  switch (payload.type) {
    case "objective.created":
      return { kind: "info", text: `Objective created: ${payload.title} (${payload.repoPath})` };

    case "objective.status_changed":
      return { kind: "info", text: `Objective ${payload.from} → ${payload.to}${payload.reason ? ` (${payload.reason})` : ""}` };

    case "task.created":
      return { kind: "info", text: `Task ${payload.key} created: ${payload.title}` };

    case "task.status_changed":
      return { kind: "info", text: `Task ${payload.from} → ${payload.to}${payload.reason ? ` (${payload.reason})` : ""}` };

    case "run.started":
      return { kind: "info", text: `Attempt ${payload.attempt} started — model ${payload.model}${payload.seededFromCheckpoint ? ", seeded from checkpoint" : ""}` };

    case "run.turn":
      return { kind: "muted", text: `Turn ${payload.turn} — ${fmtUsage(payload.usage)}` };

    case "run.message":
      return { kind: "info", text: truncate(payload.text, 400) };

    case "run.tool_result":
      return payload.isError
        ? { kind: "error", text: `Tool error: ${payload.tool}${payload.errorSignature ? ` — ${truncate(payload.errorSignature, 160)}` : ""}` }
        : { kind: "muted", text: `${payload.tool} result ok` };

    case "run.finished":
      return {
        kind: payload.exitReason === "completed" ? "success" : "warn",
        text: `Run finished: ${payload.exitReason} (${payload.turns} turns, ${fmtUsage(payload.usage)}, $${payload.costUsdEstimate.toFixed(4)} est., ${(payload.durationMs / 1000).toFixed(1)}s)`,
      };

    case "stall.detected":
      return { kind: "warn", text: `Stalled: ${payload.signal}${payload.detail ? ` — ${payload.detail}` : ""}` };

    case "checkpoint.written":
      return { kind: "info", text: `Checkpoint written (${payload.ruledOutCount} approach${payload.ruledOutCount === 1 ? "" : "es"} ruled out)` };

    case "policy.evaluated": {
      const where = payload.target ? `: ${truncate(payload.target, 160)}` : "";
      if (payload.action === "deny") return { kind: "error", text: `Denied — ${payload.tool}${where} (${payload.policyKey})` };
      if (payload.action === "ask") return { kind: "warn", text: `Needs decision — ${payload.tool}${where} (${payload.policyKey})` };
      if (payload.action === "warn") return { kind: "warn", text: `Warned — ${payload.tool}${where}: ${payload.reason}` };
      return { kind: "muted", text: `${payload.tool}${where}` };
    }

    case "verify.check":
      return {
        kind: payload.passed ? "success" : "error",
        text: `[${payload.passed ? "PASS" : "FAIL"}] ${payload.label} (exit ${payload.exitCode}, ${payload.durationMs}ms)`,
      };

    case "verify.result":
      return {
        kind: payload.passed ? "success" : "error",
        text: payload.passed ? "Acceptance passed" : `Acceptance failed: ${payload.failedLabels.join(", ")}`,
      };

    case "review.result": {
      const missing = payload.missing.length ? ` (missing: ${payload.missing.join(", ")})` : "";
      return {
        kind: payload.verdict === "accept" ? "success" : "warn",
        text:
          payload.verdict === "accept"
            ? "Judge: accepted"
            : `Judge: ${payload.verdict} — ${payload.reasons.join("; ") || "no reason given"}${missing}`,
      };
    }

    case "diagnose.result":
      return { kind: "info", text: `Diagnosis: ${payload.class} — ${truncate(payload.cause, 200)} (next: ${payload.nextAction})` };

    case "decision.raised":
      return { kind: "warn", text: `Decision needed (${payload.level}): ${payload.title} [${payload.key}]` };

    case "decision.answered":
      return { kind: "info", text: `Decision ${payload.key} answered "${payload.answer}" by ${payload.answeredBy}` };

    case "ratelimit.hit":
      return { kind: "warn", text: "Rate limit hit — pausing" };

    case "ratelimit.cleared":
      return { kind: "info", text: `Rate limit cleared after ${Math.round(payload.parkedMs / 1000)}s parked` };

    case "brain.call":
      return { kind: payload.ok ? "muted" : "error", text: `Brain call ${payload.site}: ${payload.ok ? "ok" : "failed"} (${payload.durationMs}ms)` };

    case "finding.recorded":
      return { kind: "info", text: `Finding: ${payload.title}${payload.detail ? ` — ${truncate(payload.detail, 200)}` : ""}` };

    case "run.progress":
      return { kind: "info", text: `${payload.milestone}${payload.detail ? `: ${truncate(payload.detail, 200)}` : ""}` };

    case "note":
      return { kind: "muted", text: payload.message };

    case "objective.approved":
      return {
        kind: "success",
        text: `Approved and merged ${payload.branch} into ${payload.baseRef} by ${payload.approvedBy}${payload.pushed ? " (pushed)" : " (local only — push failed or no remote)"}`,
      };

    case "graphify.unavailable":
      return { kind: "warn", text: `graphify unavailable: ${truncate(payload.detail, 200)}` };
  }
}
