import { z } from "zod";
import {
  EscalationLevel,
  RunExitReason,
  TaskStatus,
  TokenUsageSchema,
} from "./schemas.js";

/**
 * The event log is the source of truth. Every other table is a projection that can
 * be rebuilt by replaying these rows in order.
 *
 * Payloads are a discriminated union because several consumers read them
 * programmatically — the stall detector, the rate-limit scheduler, and the report
 * generator all pattern-match on event type and then use the payload fields.
 */

export const EventLevel = z.enum(["debug", "info", "warn", "error"]);
export type EventLevel = z.infer<typeof EventLevel>;

/* -- lifecycle -- */

const ObjectiveCreated = z.object({
  type: z.literal("objective.created"),
  title: z.string(),
  repoPath: z.string(),
});

const ObjectiveStatusChanged = z.object({
  type: z.literal("objective.status_changed"),
  from: z.string(),
  to: z.string(),
  reason: z.string().optional(),
});

const TaskCreated = z.object({
  type: z.literal("task.created"),
  key: z.string(),
  title: z.string(),
  dependsOn: z.array(z.string()),
});

const TaskStatusChanged = z.object({
  type: z.literal("task.status_changed"),
  from: TaskStatus,
  to: TaskStatus,
  reason: z.string().optional(),
});

/* -- worker runs -- */

const RunStarted = z.object({
  type: z.literal("run.started"),
  sessionId: z.string(),
  model: z.string(),
  worktreePath: z.string(),
  attempt: z.number().int(),
  seededFromCheckpoint: z.boolean().default(false),
});

/** One assistant turn. Usage drives the context-pressure estimate. */
const RunTurn = z.object({
  type: z.literal("run.turn"),
  turn: z.number().int(),
  usage: TokenUsageSchema,
  contextFraction: z.number().min(0).max(1).optional(),
});

/** The assistant's own narration — a completed text content block, not a tool
 *  call (those are covered by policy.evaluated) and not extended-thinking
 *  (deliberately not surfaced: often long, and not meant for display). This is
 *  what lets a terminal watching a run show what the worker is doing as it
 *  happens, instead of staying silent until the whole attempt finishes. */
const RunMessage = z.object({
  type: z.literal("run.message"),
  text: z.string(),
});

const RunToolResult = z.object({
  type: z.literal("run.tool_result"),
  tool: z.string(),
  isError: z.boolean().default(false),
  /** Normalised error signature, used to detect the same failure recurring. */
  errorSignature: z.string().optional(),
});

const RunFinished = z.object({
  type: z.literal("run.finished"),
  exitReason: RunExitReason,
  turns: z.number().int(),
  usage: TokenUsageSchema,
  costUsdEstimate: z.number(),
  durationMs: z.number().int(),
});

/* -- supervision -- */

const StallDetected = z.object({
  type: z.literal("stall.detected"),
  /** Which detector fired, e.g. "no_churn", "repeat_error", "context_pressure". */
  signal: z.string(),
  detail: z.string().default(""),
});

const CheckpointWritten = z.object({
  type: z.literal("checkpoint.written"),
  artifactId: z.string(),
  ruledOutCount: z.number().int(),
});

const PolicyEvaluated = z.object({
  type: z.literal("policy.evaluated"),
  policyKey: z.string(),
  tool: z.string(),
  action: z.string(),
  reason: z.string().default(""),
  /** The command or path that triggered the match, when the tool call carried one —
   *  what turns "POLICY-005 denied" into a readable report line. */
  target: z.string().optional(),
});

const VerifyCheck = z.object({
  type: z.literal("verify.check"),
  label: z.string(),
  command: z.string(),
  exitCode: z.number().int(),
  passed: z.boolean(),
  durationMs: z.number().int(),
});

const VerifyResult = z.object({
  type: z.literal("verify.result"),
  passed: z.boolean(),
  failedLabels: z.array(z.string()).default([]),
});

/* -- escalation and limits -- */

const DecisionRaised = z.object({
  type: z.literal("decision.raised"),
  key: z.string(),
  level: EscalationLevel,
  title: z.string(),
  blockedTaskIds: z.array(z.string()).default([]),
});

const DecisionAnswered = z.object({
  type: z.literal("decision.answered"),
  key: z.string(),
  answer: z.string(),
  answeredBy: z.string(),
});

const RateLimitHit = z.object({
  type: z.literal("ratelimit.hit"),
  retryDelayMs: z.number().int().optional(),
  source: z.enum(["api_retry", "result"]),
});

const RateLimitCleared = z.object({
  type: z.literal("ratelimit.cleared"),
  parkedMs: z.number().int(),
});

/* -- misc -- */

const BrainCall = z.object({
  type: z.literal("brain.call"),
  site: z.string(),
  ok: z.boolean(),
  durationMs: z.number().int(),
});

const FindingRecorded = z.object({
  type: z.literal("finding.recorded"),
  title: z.string(),
  detail: z.string().default(""),
});

const ProgressReported = z.object({
  type: z.literal("run.progress"),
  milestone: z.string(),
  detail: z.string().default(""),
});

const Note = z.object({
  type: z.literal("note"),
  message: z.string(),
});

export const EventPayloadSchema = z.discriminatedUnion("type", [
  ObjectiveCreated,
  ObjectiveStatusChanged,
  TaskCreated,
  TaskStatusChanged,
  RunStarted,
  RunTurn,
  RunMessage,
  RunToolResult,
  RunFinished,
  StallDetected,
  CheckpointWritten,
  PolicyEvaluated,
  VerifyCheck,
  VerifyResult,
  DecisionRaised,
  DecisionAnswered,
  RateLimitHit,
  RateLimitCleared,
  BrainCall,
  FindingRecorded,
  ProgressReported,
  Note,
]);
export type EventPayload = z.infer<typeof EventPayloadSchema>;
export type EventType = EventPayload["type"];

/** Narrow an event payload to one variant. */
export function isEvent<T extends EventType>(
  payload: EventPayload,
  type: T,
): payload is Extract<EventPayload, { type: T }> {
  return payload.type === type;
}

export const EventSchema = z.object({
  id: z.number().int().optional(), // assigned by the store
  ts: z.number().int(),
  level: EventLevel.default("info"),
  objectiveId: z.string().optional(),
  taskId: z.string().optional(),
  runId: z.string().optional(),
  payload: EventPayloadSchema,
});
export type ExecEvent = z.infer<typeof EventSchema>;
