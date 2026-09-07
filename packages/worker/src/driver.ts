import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  HookInput,
  HookJSONOutput,
  Options,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  Budget,
  EffortLevel,
  EventPayload,
  Policy,
  RunExitReason,
  TokenUsage,
} from "@exec/core";
import {
  createPolicyHook,
  extractCommand,
  extractPath,
  type PreToolUseHookOutput,
  type ToolCall,
} from "@exec/policy";
import {
  createSupervisorTools,
  type SupervisorToolCallbacks,
} from "./tools.js";
import {
  DEFAULT_STALL_CONFIG,
  contextFraction,
  detectStall,
  interpretRateLimit,
  normalizeError,
  type RateLimitInfo,
  type StallSignal,
  type TurnSample,
} from "./telemetry.js";
import { churn } from "./worktree.js";

/**
 * The worker driver: the one place that talks to the Claude Agent SDK.
 *
 * Everything above this module works with plain data (events, verdicts,
 * checkpoints); everything below it is the SDK's business. That boundary is
 * deliberate — it is what lets a Codex driver be added later as a second
 * implementation of the same shape rather than a rewrite of the supervisor.
 */

export interface WorkerPrompt {
  intent: string;
  ruledOut: string[];
  checkpointNote?: string;
}

function buildPrompt(prompt: WorkerPrompt): string {
  const parts = [prompt.intent];

  if (prompt.ruledOut.length > 0) {
    parts.push(
      "\nThe following approaches were already tried in a previous attempt on " +
        "this task and are RULED OUT — do not repeat them:\n" +
        prompt.ruledOut.map((r) => `- ${r}`).join("\n"),
    );
  }

  if (prompt.checkpointNote) {
    parts.push(`\nContext carried over from the previous attempt:\n${prompt.checkpointNote}`);
  }

  parts.push(
    "\nWhen you are done, or if you get stuck, call report_progress with a final " +
      "milestone summarising what you changed and why.",
  );

  return parts.join("\n");
}

const toTokenUsage = (u: {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
}): TokenUsage => ({
  input: u.input_tokens ?? 0,
  output: u.output_tokens ?? 0,
  cacheRead: u.cache_read_input_tokens ?? 0,
  cacheCreation: u.cache_creation_input_tokens ?? 0,
});

export interface RunWorkerArgs {
  sessionId: string;
  cwd: string;
  model: string;
  effort: EffortLevel;
  budget: Budget;
  prompt: WorkerPrompt;
  policies: Policy[];
  /** Context window in tokens, for the pressure fraction. Defaults to 1M
   *  (current-generation Claude models). */
  contextWindow?: number;
  onEvent: (payload: EventPayload) => void;
  supervisorCallbacks: SupervisorToolCallbacks;
}

export interface RunWorkerResult {
  exitReason: RunExitReason;
  turns: number;
  usage: TokenUsage;
  costUsdEstimate: number;
  stallSignal?: StallSignal;
  resultText?: string;
  isError: boolean;
}

/** Extract the tool name and target path off a PreToolUse hook input, for telemetry. */
function toToolCall(input: HookInput & { hook_event_name: "PreToolUse" }): {
  tool: string;
  targetPath?: string;
} {
  const call: ToolCall = { tool: input.tool_name, input: input.tool_input };
  const path = extractPath(call);
  return path === undefined ? { tool: call.tool } : { tool: call.tool, targetPath: path };
}

/**
 * Run one worker attempt to completion, to a stall, or to a rate-limit park.
 *
 * The loop below is the only place in the system that reads the SDK message
 * stream. It does three jobs at once: forward everything to the event log,
 * accumulate per-turn samples for the stall detector, and watch for a live
 * rate-limit signal so the caller can park the objective before the wall is hit.
 */
export async function runWorker(args: RunWorkerArgs): Promise<RunWorkerResult> {
  const contextWindow = args.contextWindow ?? 1_000_000;
  const samples: TurnSample[] = [];

  let turnToolCalls: { tool: string; targetPath?: string }[] = [];
  let turnErrors: string[] = [];
  let turns = 0;
  let usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let costUsdEstimate = 0;
  let exitReason: RunExitReason = "completed";
  let isError = false;
  let stallSignal: StallSignal | undefined;
  let resultText: string | undefined;

  const policyHook = createPolicyHook({
    loadPolicies: () => args.policies,
    onVerdict: (call, verdict) => {
      const target = extractCommand(call) ?? extractPath(call);
      args.onEvent({
        type: "policy.evaluated",
        policyKey: verdict.policy?.key ?? "-",
        tool: call.tool,
        action: verdict.action,
        reason: verdict.reason,
        ...(target !== undefined ? { target } : {}),
      });
    },
  });

  const supervisorServer = createSupervisorTools(args.supervisorCallbacks);
  const abortController = new AbortController();

  const options: Options = {
    cwd: args.cwd,
    model: args.model,
    effort: args.effort,
    sessionId: args.sessionId,
    maxTurns: args.budget.maxTurns,
    permissionMode: "default",
    abortController,
    mcpServers: { exec: supervisorServer },
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input: HookInput): Promise<HookJSONOutput> => {
              if (input.hook_event_name !== "PreToolUse") return {};
              turnToolCalls.push(toToolCall(input));
              const out: PreToolUseHookOutput = policyHook({
                tool: input.tool_name,
                input: input.tool_input,
              });
              return out;
            },
          ],
        },
      ],
      PostToolUseFailure: [
        {
          hooks: [
            async (input: HookInput): Promise<HookJSONOutput> => {
              if (input.hook_event_name !== "PostToolUseFailure") return {};
              turnErrors.push(normalizeError(input.error));
              args.onEvent({
                type: "run.tool_result",
                tool: input.tool_name,
                isError: true,
                errorSignature: normalizeError(input.error),
              });
              return {};
            },
          ],
        },
      ],
    },
  };

  const startedAt = Date.now();
  const q = query({ prompt: buildPrompt(args.prompt), options });

  for await (const msg of q) {
    if (msg.type === "assistant") {
      turns += 1;
      usage = toTokenUsage(msg.message.usage);

      const sample: TurnSample = {
        turn: turns,
        usage,
        toolCalls: turnToolCalls,
        errorSignatures: turnErrors,
        churn: churn(args.cwd).linesChanged,
      };
      samples.push(sample);
      turnToolCalls = [];
      turnErrors = [];

      args.onEvent({
        type: "run.turn",
        turn: turns,
        usage,
        contextFraction: contextFraction(sample, contextWindow),
      });

      const wallClockMs = Date.now() - startedAt;
      const stall =
        wallClockMs > args.budget.maxWallClockMs
          ? {
              signal: "wall_clock_budget" as const,
              detail: `reached the ${Math.round(args.budget.maxWallClockMs / 1000)}s wall-clock budget for this task`,
            }
          : detectStall({
              samples,
              contextWindow,
              maxTurns: args.budget.maxTurns,
              config: DEFAULT_STALL_CONFIG,
            });
      if (stall) {
        stallSignal = stall;
        args.onEvent({ type: "stall.detected", signal: stall.signal, detail: stall.detail });
        await q.interrupt().catch(() => {
          /* best effort — we are exiting the loop either way */
        });
        exitReason = "stalled";
        break;
      }
      continue;
    }

    if (msg.type === "rate_limit_event") {
      const info: RateLimitInfo = {
        status: msg.rate_limit_info.status,
        resetsAt: msg.rate_limit_info.resetsAt,
        rateLimitType: msg.rate_limit_info.rateLimitType,
        utilization: msg.rate_limit_info.utilization,
      };
      const verdict = interpretRateLimit(info);
      if (verdict.park) {
        args.onEvent({
          type: "ratelimit.hit",
          source: "result",
          retryDelayMs: verdict.resumeAt ? Math.max(0, verdict.resumeAt - Date.now()) : undefined,
        });
        await q.interrupt().catch(() => {});
        exitReason = "rate_limited";
        break;
      }
      continue;
    }

    if (msg.type === "result") {
      turns = msg.num_turns;
      costUsdEstimate = msg.total_cost_usd;
      isError = msg.is_error;
      if (msg.subtype === "success") {
        resultText = msg.result;
      } else if (exitReason === "completed") {
        // Only override if nothing more specific (stall/rate-limit) already fired.
        exitReason = msg.subtype === "error_max_turns" ? "budget_exhausted" : "error";
      }
      args.onEvent({
        type: "run.finished",
        exitReason,
        turns,
        usage,
        costUsdEstimate,
        durationMs: msg.duration_ms,
      });
      break;
    }
  }

  return {
    exitReason,
    turns,
    usage,
    costUsdEstimate,
    isError,
    ...(stallSignal !== undefined ? { stallSignal } : {}),
    ...(resultText !== undefined ? { resultText } : {}),
  };
}
