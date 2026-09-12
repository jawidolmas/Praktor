import { z } from "zod";

/* ------------------------------------------------------------------ *
 * Budgets
 *
 * Denominated in turns, tokens and wall-clock — NOT dollars. On a Claude
 * subscription nothing is billed per token, so total_cost_usd from the SDK is a
 * notional estimate only. We record it for reporting but never gate on it.
 * ------------------------------------------------------------------ */

export const BudgetSchema = z.object({
  maxTurns: z.number().int().positive().default(40),
  maxTokens: z.number().int().positive().default(400_000),
  maxWallClockMs: z.number().int().positive().default(30 * 60_000),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const TokenUsageSchema = z.object({
  input: z.number().int().nonnegative().default(0),
  output: z.number().int().nonnegative().default(0),
  cacheRead: z.number().int().nonnegative().default(0),
  cacheCreation: z.number().int().nonnegative().default(0),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/** Tokens that count against the context window on the next request. */
export const contextTokens = (u: TokenUsage): number =>
  u.input + u.cacheRead + u.cacheCreation;

/* ------------------------------------------------------------------ *
 * Acceptance — the anti-hallucination backbone
 *
 * The supervisor believes a command exit code, never a worker claim of success.
 * Every task must carry at least one check, or it cannot be verified and will not
 * be scheduled.
 * ------------------------------------------------------------------ */

export const AcceptanceCheckSchema = z.object({
  /** Short label used in reports, e.g. "unit tests pass". */
  label: z.string().min(1),
  /** Shell command run in the task worktree. */
  command: z.string().min(1),
  expectExitCode: z.number().int().default(0),
  /** Optional substring the stdout must contain. */
  expectStdout: z.string().optional(),
  timeoutMs: z.number().int().positive().default(10 * 60_000),
});
export type AcceptanceCheck = z.infer<typeof AcceptanceCheckSchema>;

export const AcceptanceSpecSchema = z.object({
  checks: z.array(AcceptanceCheckSchema).min(1),
});
export type AcceptanceSpec = z.infer<typeof AcceptanceSpecSchema>;

/* ------------------------------------------------------------------ *
 * Objectives and tasks
 * ------------------------------------------------------------------ */

export const ObjectiveStatus = z.enum([
  "draft",
  "active",
  "parked", // rate limit or scheduled pause; resumable
  "blocked", // waiting on an L3 decision
  "done",
  "failed",
  "cancelled",
]);
export type ObjectiveStatus = z.infer<typeof ObjectiveStatus>;

/**
 * What the supervisor does when a task exhausts its attempt budget and
 * cannot be recovered mechanically. "escalate" (the default) raises an L3
 * decision instead of silently giving up — the one behavior that actually
 * makes "own the objective until told otherwise" true. "abandon" and "skip"
 * exist for objectives where a person has already decided, up front, what a
 * failure there should mean, so the daemon doesn't have to ask every time.
 */
export const ObjectiveOnFailure = z.enum(["escalate", "abandon", "skip"]);
export type ObjectiveOnFailure = z.infer<typeof ObjectiveOnFailure>;

export const EffortLevel = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type EffortLevel = z.infer<typeof EffortLevel>;

export const ObjectiveSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  brief: z.string().default(""),
  repoPath: z.string().min(1),
  baseRef: z.string().default("HEAD"),
  status: ObjectiveStatus.default("draft"),
  budget: BudgetSchema,
  onFailure: ObjectiveOnFailure.default("escalate"),
  /**
   * Defaults handed to every task this objective's tasks are created with —
   * needed even before a single task exists, because a freshly submitted
   * objective can sit in "draft" (awaiting decomposition) across a daemon
   * restart, and the daemon reconstructs everything from these rows alone.
   */
  model: z.string().default("claude-sonnet-5"),
  effort: EffortLevel.default("medium"),
  maxAttempts: z.number().int().positive().default(3),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Objective = z.infer<typeof ObjectiveSchema>;

export const TaskStatus = z.enum([
  "pending", // dependencies unmet
  "ready", // schedulable
  "running",
  "verifying",
  "blocked", // waiting on a decision
  "parked", // rate limited
  "done",
  "failed",
  "abandoned",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/**
 * Task class drives budget defaults and the tool surface a worker is granted.
 * An investigate task, for instance, gets read-only tools.
 */
export const TaskClass = z.enum([
  "investigate",
  "implement",
  "fix",
  "test",
  "refactor",
  "docs",
]);
export type TaskClass = z.infer<typeof TaskClass>;

export const TaskSchema = z.object({
  id: z.string(),
  objectiveId: z.string(),
  key: z.string(), // T-001
  title: z.string().min(1),
  /** What to do and why — this becomes the worker prompt. */
  intent: z.string().min(1),
  taskClass: TaskClass,
  acceptance: AcceptanceSpecSchema,
  dependsOn: z.array(z.string()).default([]), // task ids
  status: TaskStatus.default("pending"),
  attempts: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(3),
  budget: BudgetSchema,
  /** How to run the worker. Stored on the task (not just the run) because the
   *  daemon picks a task up and drives it from the database alone, with no
   *  in-memory args left over from whoever submitted it. */
  model: z.string(),
  effort: EffortLevel.default("medium"),
  /** Approaches ruled out by earlier attempts; seeded into every respawn. */
  ruledOut: z.array(z.string()).default([]),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Task = z.infer<typeof TaskSchema>;

/* ------------------------------------------------------------------ *
 * Runs — one worker attempt at one task
 * ------------------------------------------------------------------ */

export const RunExitReason = z.enum([
  "completed",
  "acceptance_failed",
  "stalled",
  "policy_denied",
  "escalated",
  "rate_limited",
  "budget_exhausted",
  "error",
  "killed",
]);
export type RunExitReason = z.infer<typeof RunExitReason>;

export const RunSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  objectiveId: z.string(),
  attempt: z.number().int().positive(),
  sessionId: z.string(), // UUID we assign; the SDK honours it
  model: z.string(),
  effort: EffortLevel.default("high"),
  worktreePath: z.string(),
  status: z.enum(["running", "finished"]).default("running"),
  exitReason: RunExitReason.optional(),
  turns: z.number().int().nonnegative().default(0),
  usage: TokenUsageSchema,
  /** Notional API cost from the SDK. Reported, never gated on. */
  costUsdEstimate: z.number().nonnegative().default(0),
  startedAt: z.number().int(),
  endedAt: z.number().int().optional(),
});
export type Run = z.infer<typeof RunSchema>;

/* ------------------------------------------------------------------ *
 * Checkpoints — state compression, not "start a new chat"
 * ------------------------------------------------------------------ */

export const CheckpointSchema = z.object({
  objective: z.string(),
  task: z.string(),
  /** Only what acceptance checks actually confirmed. */
  verifiedDone: z.array(z.string()).default([]),
  currentProblem: z.string(),
  relevantFiles: z.array(z.string()).default([]),
  /** Tried and failed, with the outcome — so a fresh session cannot repeat them. */
  attemptsTried: z
    .array(z.object({ approach: z.string(), outcome: z.string() }))
    .default([]),
  doNotRepeat: z.array(z.string()).default([]),
  nextHypothesis: z.string().optional(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

/* ------------------------------------------------------------------ *
 * Decisions — escalation as a first-class, resumable object
 * ------------------------------------------------------------------ */

export const EscalationLevel = z.enum(["L0", "L1", "L2", "L3"]);
export type EscalationLevel = z.infer<typeof EscalationLevel>;

export const DecisionOptionSchema = z.object({
  id: z.string().min(1), // "A", "B", ...
  label: z.string().min(1),
  pros: z.array(z.string()).default([]),
  cons: z.array(z.string()).default([]),
});
export type DecisionOption = z.infer<typeof DecisionOptionSchema>;

export const DecisionStatus = z.enum([
  "open",
  "answered",
  "expired",
  "withdrawn",
]);
export type DecisionStatus = z.infer<typeof DecisionStatus>;

export const DecisionSchema = z.object({
  id: z.string(),
  key: z.string(), // DEC-024
  objectiveId: z.string(),
  taskId: z.string().optional(),
  runId: z.string().optional(),
  level: EscalationLevel,
  title: z.string().min(1),
  context: z.string().min(1),
  options: z.array(DecisionOptionSchema).min(2),
  /**
   * Option id the supervisor recommends. Always present — an escalation without a
   * recommendation just pushes the work back onto the person.
   */
  recommendation: z.string().min(1),
  risk: z.enum(["low", "medium", "high"]),
  blockedTaskIds: z.array(z.string()).default([]),
  status: DecisionStatus.default("open"),
  answer: z.string().optional(),
  answeredBy: z.string().optional(),
  answeredAt: z.number().int().optional(),
  rationale: z.string().optional(),
  deadline: z.number().int().optional(),
  createdAt: z.number().int(),
});
export type Decision = z.infer<typeof DecisionSchema>;

/* ------------------------------------------------------------------ *
 * Policies — enforced by the harness, not by prompting
 * ------------------------------------------------------------------ */

export const PolicySeverity = z.enum(["HARD", "SOFT"]);
export type PolicySeverity = z.infer<typeof PolicySeverity>;

export const PolicyAction = z.enum(["deny", "ask", "warn", "allow"]);
export type PolicyAction = z.infer<typeof PolicyAction>;

/**
 * A matcher describes the tool calls a policy applies to. All present fields must
 * match. Patterns are JS regular expression sources, tested case-insensitively.
 */
export const PolicyMatcherSchema = z.object({
  /** Tool name, e.g. "Bash", "Edit", "Write". Omit to match any tool. */
  tool: z.string().optional(),
  /**
   * Regex (or several) against the Bash command string. A single string is one
   * test; an array requires every pattern to match (AND) — each pattern stays
   * small and readable, and the co-occurrence itself is what signals danger.
   * Prefer an array over one dense pattern for anything security-relevant: a
   * single regex trying to pin an exact command shape (e.g. requiring "git"
   * immediately adjacent to "push") breaks the moment a worker phrases the
   * same command differently (e.g. `git -C <path> push` instead of `git push`
   * after `cd`) — a real case that let a "no push to main" policy through
   * silently. An array of independent signals ("contains push", "contains a
   * protected branch as the push target") stays robust to phrasing.
   */
  commandPattern: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
  /** Regex against a file path argument. */
  pathPattern: z.string().optional(),
});
export type PolicyMatcher = z.infer<typeof PolicyMatcherSchema>;

export const PolicySchema = z.object({
  id: z.string(),
  key: z.string(), // POLICY-003
  title: z.string().min(1),
  rationale: z.string().default(""),
  matcher: PolicyMatcherSchema,
  severity: PolicySeverity,
  action: PolicyAction,
  /** "global", or "objective:<id>", or "repo:<path>". */
  scope: z.string().default("global"),
  enabled: z.boolean().default(true),
  createdAt: z.number().int(),
});
export type Policy = z.infer<typeof PolicySchema>;

/* ------------------------------------------------------------------ *
 * Memory
 * ------------------------------------------------------------------ */

export const MemoryTier = z.enum(["permanent", "project", "session"]);
export type MemoryTier = z.infer<typeof MemoryTier>;

export const MemorySchema = z.object({
  id: z.string(),
  tier: MemoryTier,
  /** Objective id for project tier, run id for session tier, empty for permanent. */
  scopeId: z.string().default(""),
  title: z.string().min(1),
  content: z.string().min(1),
  source: z.string().default(""),
  createdAt: z.number().int(),
});
export type Memory = z.infer<typeof MemorySchema>;
