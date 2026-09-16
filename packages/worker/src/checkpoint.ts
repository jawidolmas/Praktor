import type { Checkpoint, ReviewOutput } from "@exec/core";
import type { StallSignal } from "./telemetry.js";
import type { VerifyOutcome } from "./verify.js";

/**
 * Build a checkpoint mechanically — no LLM call.
 *
 * This is deliberately the honest, non-magical version of "state compression": it
 * records what is actually known (files touched, the concrete failure, what was
 * ruled out) rather than an LLM's summary of the transcript. An LLM-written
 * checkpoint is a real improvement for later, but everything it would need —
 * verified status, ruled-out approaches, the failing command — is already here in
 * structured form, so a respawned worker is not repeating known-bad attempts
 * either way.
 */

export interface BuildCheckpointArgs {
  taskTitle: string;
  intent: string;
  filesChanged: string[];
  ruledOut: string[];
  stallSignal?: StallSignal;
  verify?: VerifyOutcome;
  /** Set when the judge (`review` in brain.ts) sent a mechanically-passing
   *  attempt back — mutually exclusive with `stallSignal` in practice, since
   *  the judge only ever runs once a run completed and its acceptance checks
   *  passed. */
  review?: ReviewOutput;
  resultText?: string;
}

export function buildCheckpoint(args: BuildCheckpointArgs): Checkpoint {
  const attemptsTried: { approach: string; outcome: string }[] = [];
  const doNotRepeat = [...args.ruledOut];

  let currentProblem = "The previous attempt did not reach a verified done state.";

  if (args.stallSignal?.signal === "decision_timeout") {
    // Not a failed approach — the worker correctly asked a question and
    // nobody had answered it yet. There is nothing here to rule out; doing
    // so would wrongly tell a respawned worker to avoid asking questions.
    currentProblem = `Paused: ${args.stallSignal.detail}`;
  } else if (args.stallSignal) {
    currentProblem = `Stalled: ${args.stallSignal.detail}`;
    attemptsTried.push({
      approach: args.resultText?.slice(0, 300) ?? args.intent,
      outcome: `stalled (${args.stallSignal.signal}): ${args.stallSignal.detail}`,
    });
    doNotRepeat.push(
      `Whatever led to: ${args.stallSignal.signal} — ${args.stallSignal.detail}`,
    );
  }

  if (args.verify && !args.verify.passed) {
    const failed = args.verify.checks.filter((c) => !c.passed);
    currentProblem = `Acceptance failed: ${failed.map((c) => c.label).join(", ")}`;
    for (const check of failed) {
      const detail = (check.runError ?? check.stderr ?? check.stdout ?? "").slice(
        0,
        500,
      );
      attemptsTried.push({
        approach: `ran "${check.command}" expecting exit ${0}`,
        outcome: `exit ${check.exitCode ?? "n/a"}${detail ? `: ${detail}` : ""}`,
      });
    }
  }

  if (args.review && args.review.verdict !== "accept") {
    const reasons = args.review.reasons.join("; ") || "no reason given";
    const missing = args.review.missing.length > 0 ? ` Still missing: ${args.review.missing.join("; ")}.` : "";
    const verb = args.review.verdict === "reject" ? "rejected" : "sent back for revision";
    currentProblem = `Praktor's review ${verb} this attempt: ${reasons}.${missing}`;
    attemptsTried.push({
      approach: args.resultText?.slice(0, 300) ?? args.intent,
      outcome: `review verdict: ${args.review.verdict} — ${reasons}`,
    });
    doNotRepeat.push(`Whatever led to a review verdict of "${args.review.verdict}": ${reasons}`);
  }

  return {
    objective: args.taskTitle,
    task: args.taskTitle,
    verifiedDone: [],
    currentProblem,
    relevantFiles: args.filesChanged,
    attemptsTried,
    doNotRepeat,
  };
}

/** Render a checkpoint into the note seeded at the top of a respawned worker's prompt. */
export function renderCheckpointNote(checkpoint: Checkpoint): string {
  const lines: string[] = [];
  lines.push(`Problem from the previous attempt: ${checkpoint.currentProblem}`);
  if (checkpoint.relevantFiles.length) {
    lines.push(`Files touched previously: ${checkpoint.relevantFiles.join(", ")}`);
  }
  if (checkpoint.attemptsTried.length) {
    lines.push("What was tried and what happened:");
    for (const a of checkpoint.attemptsTried) {
      lines.push(`  - ${a.approach} -> ${a.outcome}`);
    }
  }
  return lines.join("\n");
}
