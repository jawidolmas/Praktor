import { contextTokens, type TokenUsage } from "@exec/core";

/**
 * Worker health telemetry.
 *
 * Everything here is a pure function over samples collected from the message
 * stream, so the whole stall-detection story is testable from recorded fixtures
 * without spending any usage.
 *
 * The question this module answers is not "is the worker busy" — a thrashing worker
 * is extremely busy — but "is the worker still making progress".
 */

export interface TurnSample {
  turn: number;
  usage: TokenUsage;
  /** Tools invoked during this turn. */
  toolCalls: { tool: string; targetPath?: string }[];
  /** Normalised signatures of errors seen this turn. */
  errorSignatures: string[];
  /** Lines added + removed in the worktree since the previous turn. */
  churn: number;
}

export interface StallConfig {
  /** Fraction of the context window past which we checkpoint rather than push on. */
  contextPressureThreshold: number;
  /** How many times the same error may recur before we call it a loop. */
  maxRepeatedErrors: number;
  /** Turns of tool activity with no diff churn that count as thrashing. */
  noChurnTurns: number;
  /** Below this many tool calls, zero churn just means the worker is reading. */
  minToolCallsForChurnCheck: number;
  /** Times the same file may be edited across no-churn turns. */
  maxSameFileEdits: number;
}

export const DEFAULT_STALL_CONFIG: StallConfig = {
  contextPressureThreshold: 0.75,
  maxRepeatedErrors: 3,
  noChurnTurns: 5,
  minToolCallsForChurnCheck: 6,
  maxSameFileEdits: 4,
};

export interface StallSignal {
  /** Which detector fired. Recorded on the stall.detected event. */
  signal:
    | "context_pressure"
    | "repeat_error"
    | "no_churn"
    | "file_thrash"
    | "turn_budget"
    | "wall_clock_budget";
  detail: string;
}

const WRITE_TOOLS = new Set(["edit", "write", "notebookedit", "multiedit"]);

/**
 * Collapse an error message to a signature that is stable across runs.
 *
 * Line numbers, hex addresses, timings and temp paths all vary between otherwise
 * identical failures, so they are replaced before comparison. Without this the
 * "same error three times" detector never fires.
 */
export function normalizeError(message: string): string {
  return message
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, "<addr>")
    .replace(/\b\d+(\.\d+)?(ms|s|us|ns)\b/g, "<dur>")
    .replace(/:\d+:\d+/g, ":<pos>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** Context used as a fraction of the window, from the most recent turn. */
export function contextFraction(
  sample: TurnSample,
  contextWindow: number,
): number {
  if (contextWindow <= 0) return 0;
  return Math.min(1, contextTokens(sample.usage) / contextWindow);
}

export interface DetectStallArgs {
  samples: TurnSample[];
  contextWindow: number;
  maxTurns: number;
  config?: StallConfig;
}

/**
 * Decide whether a worker has stopped making progress.
 *
 * Returns the first signal that fires, most decisive first — context pressure
 * before behavioural signals, because a worker near the window limit will produce
 * thrashing symptoms as a consequence rather than a cause.
 */
export function detectStall(args: DetectStallArgs): StallSignal | null {
  const config = args.config ?? DEFAULT_STALL_CONFIG;
  const { samples, contextWindow, maxTurns } = args;
  const latest = samples.at(-1);
  if (!latest) return null;

  const fraction = contextFraction(latest, contextWindow);
  if (fraction >= config.contextPressureThreshold) {
    return {
      signal: "context_pressure",
      detail: `context at ${Math.round(fraction * 100)}% of the window`,
    };
  }

  if (latest.turn >= maxTurns) {
    return {
      signal: "turn_budget",
      detail: `reached the ${maxTurns}-turn budget for this task`,
    };
  }

  // The same failure recurring means the worker is not learning from it.
  const counts = new Map<string, number>();
  for (const sample of samples) {
    for (const sig of sample.errorSignatures) {
      counts.set(sig, (counts.get(sig) ?? 0) + 1);
    }
  }
  for (const [sig, count] of counts) {
    if (count >= config.maxRepeatedErrors) {
      return {
        signal: "repeat_error",
        detail: `the same error recurred ${count} times: ${sig}`,
      };
    }
  }

  // Busy but not moving: plenty of tool calls, nothing changing on disk.
  const window = samples.slice(-config.noChurnTurns);
  if (window.length === config.noChurnTurns) {
    const toolCalls = window.reduce((n, s) => n + s.toolCalls.length, 0);
    const churn = window.reduce((n, s) => n + s.churn, 0);
    if (churn === 0 && toolCalls >= config.minToolCallsForChurnCheck) {
      return {
        signal: "no_churn",
        detail: `${toolCalls} tool calls over ${window.length} turns with no change to the working tree`,
      };
    }

    // Circling one file: repeated writes to the same path without net progress.
    if (churn === 0) {
      const edits = new Map<string, number>();
      for (const sample of window) {
        for (const call of sample.toolCalls) {
          if (!WRITE_TOOLS.has(call.tool.toLowerCase())) continue;
          if (!call.targetPath) continue;
          edits.set(call.targetPath, (edits.get(call.targetPath) ?? 0) + 1);
        }
      }
      for (const [path, count] of edits) {
        if (count >= config.maxSameFileEdits) {
          return {
            signal: "file_thrash",
            detail: `${path} rewritten ${count} times with no net change`,
          };
        }
      }
    }
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * Rate limits
 *
 * On a claude.ai subscription the SDK emits a `rate_limit_event` carrying live
 * utilisation and a reset time. That lets the scheduler park *before* hitting the
 * wall rather than discovering the limit by failing.
 * ------------------------------------------------------------------ */

export interface RateLimitInfo {
  status: "allowed" | "allowed_warning" | "rejected";
  resetsAt?: number | undefined;
  rateLimitType?: string | undefined;
  utilization?: number | undefined;
}

export interface RateLimitVerdict {
  park: boolean;
  /** Epoch millis to resume at, when known. */
  resumeAt?: number;
  reason: string;
}

/**
 * `resetsAt` is seconds since epoch in the SDK payload; everything in this system
 * is epoch millis.
 */
function resumeMillis(resetsAt: number | undefined): number | undefined {
  if (resetsAt === undefined) return undefined;
  // Values below year-2001 in millis are certainly seconds.
  return resetsAt < 1e11 ? resetsAt * 1000 : resetsAt;
}

export interface RateLimitPolicy {
  /** Utilisation past which we stop starting new work. */
  parkAboveUtilization: number;
  /** How long to wait when the limit is hit but no reset time is given. */
  fallbackParkMs: number;
}

export const DEFAULT_RATE_LIMIT_POLICY: RateLimitPolicy = {
  // Leave headroom so an in-flight task can finish rather than being cut off.
  parkAboveUtilization: 0.95,
  fallbackParkMs: 15 * 60_000,
};

export function interpretRateLimit(
  info: RateLimitInfo,
  policy: RateLimitPolicy = DEFAULT_RATE_LIMIT_POLICY,
): RateLimitVerdict {
  const resumeAt = resumeMillis(info.resetsAt);
  const kind = info.rateLimitType ? ` (${info.rateLimitType})` : "";

  if (info.status === "rejected") {
    return {
      park: true,
      resumeAt: resumeAt ?? Date.now() + policy.fallbackParkMs,
      reason: `usage limit reached${kind}`,
    };
  }

  if (
    info.status === "allowed_warning" &&
    info.utilization !== undefined &&
    info.utilization >= policy.parkAboveUtilization
  ) {
    return {
      park: true,
      resumeAt: resumeAt ?? Date.now() + policy.fallbackParkMs,
      reason: `utilisation at ${Math.round(info.utilization * 100)}%${kind}; parking before the limit is hit`,
    };
  }

  return { park: false, reason: "within limits" };
}
