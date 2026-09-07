import { z } from "zod";
import { DecisionOptionSchema } from "./schemas.js";

/**
 * Contracts between the supervisor and a worker.
 *
 * Two directions:
 *  - `WorkerResult` is what a worker returns at the end of a run. It is enforced by
 *    the SDK output schema, so the supervisor gets a typed object rather than prose.
 *  - The `*Input` schemas below define the in-process MCP tools the supervisor
 *    exposes to every worker. A worker escalates by *calling a tool*, which lands in
 *    the queue as a typed object — there is no prose to parse and no ambiguity about
 *    whether the worker was really asking for something.
 */

/* ------------------------------------------------------------------ *
 * Worker → supervisor: end-of-run result
 * ------------------------------------------------------------------ */

export const WorkerResultSchema = z.object({
  /** One paragraph on what was actually done. */
  summary: z.string(),
  /** Repo-relative paths the worker believes it changed. Verified against git. */
  filesChanged: z.array(z.string()).default([]),
  /**
   * Approaches attempted and how they turned out. Feeds the ruled-out list so a
   * later attempt cannot repeat them.
   */
  approachesTried: z
    .array(z.object({ approach: z.string(), outcome: z.string() }))
    .default([]),
  /** The worker's own read on whether the task is complete. Advisory only —
   *  acceptance checks decide. */
  selfAssessment: z.enum(["complete", "partial", "blocked"]),
  /** Anything that stopped it finishing. */
  blockers: z.array(z.string()).default([]),
});
export type WorkerResult = z.infer<typeof WorkerResultSchema>;

/* ------------------------------------------------------------------ *
 * Supervisor MCP tools — the typed escalation channel
 * ------------------------------------------------------------------ */

export const RequestDecisionInput = z.object({
  title: z.string().describe("One line naming the decision to be made"),
  context: z
    .string()
    .describe("Why this decision is needed and what is blocked by it"),
  options: z
    .array(DecisionOptionSchema)
    .min(2)
    .describe("At least two genuinely viable options, with pros and cons"),
  recommendation: z
    .string()
    .describe("The id of the option you recommend, e.g. 'B'"),
  risk: z.enum(["low", "medium", "high"]),
});
export type RequestDecisionInput = z.infer<typeof RequestDecisionInput>;

export const ReportProgressInput = z.object({
  milestone: z.string().describe("Short name of what was just completed"),
  detail: z.string().default("").describe("Optional supporting detail"),
});
export type ReportProgressInput = z.infer<typeof ReportProgressInput>;

export const CheckPolicyInput = z.object({
  action: z
    .string()
    .describe("What you are about to do, e.g. 'push to origin main'"),
  command: z
    .string()
    .optional()
    .describe("The exact command, if this is a shell action"),
});
export type CheckPolicyInput = z.infer<typeof CheckPolicyInput>;

export const RecordFindingInput = z.object({
  title: z.string().describe("Short name for the finding"),
  detail: z
    .string()
    .default("")
    .describe("What you noticed and why it matters"),
});
export type RecordFindingInput = z.infer<typeof RecordFindingInput>;

/* ------------------------------------------------------------------ *
 * Brain call-site output contracts
 * ------------------------------------------------------------------ */

/** `decompose`: objective → task DAG. */
export const DecomposeOutput = z.object({
  tasks: z
    .array(
      z.object({
        key: z.string().describe("T-001, T-002, ... unique within the objective"),
        title: z.string(),
        intent: z
          .string()
          .describe("What to do and why. Becomes the worker's prompt."),
        taskClass: z.enum([
          "investigate",
          "implement",
          "fix",
          "test",
          "refactor",
          "docs",
        ]),
        dependsOn: z
          .array(z.string())
          .default([])
          .describe("Keys of tasks that must finish first"),
        acceptance: z.object({
          checks: z
            .array(
              z.object({
                label: z.string(),
                command: z
                  .string()
                  .describe(
                    "A real shell command that proves the task is done. Must be runnable in the repo.",
                  ),
                expectExitCode: z.number().int().default(0),
              }),
            )
            .min(1),
        }),
      }),
    )
    .min(1),
});
export type DecomposeOutput = z.infer<typeof DecomposeOutput>;

/** `review`: did the work actually satisfy the intent? Runs only after acceptance passes. */
export const ReviewOutput = z.object({
  verdict: z.enum(["accept", "revise", "reject"]),
  reasons: z.array(z.string()).default([]),
  /** Requirements from the intent that the diff does not address. */
  missing: z.array(z.string()).default([]),
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;

/** `diagnose`: classify a failure so the supervisor can choose retry vs escalate. */
export const DiagnoseOutput = z.object({
  cause: z.string(),
  class: z.enum(["flaky", "bug", "spec", "env"]),
  nextAction: z.enum(["retry", "retry_with_hint", "respawn", "escalate", "abandon"]),
  /** Guidance injected into the next attempt when nextAction is retry_with_hint. */
  hint: z.string().optional(),
  /** Approaches now known not to work. */
  ruledOut: z.array(z.string()).default([]),
});
export type DiagnoseOutput = z.infer<typeof DiagnoseOutput>;
