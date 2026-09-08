import type { RunExitReason, TokenUsage } from "@exec/core";
import type { VerifyOutcome } from "@exec/worker";

/**
 * The end-of-run report.
 *
 * Deterministic and template-based, not LLM-generated — the `report` brain call
 * site from the plan turns this into prose later, but the content here (what
 * happened, what passed, what it cost) is already the substance of "you come back
 * to a report, not a transcript." Built by the daemon and stored as an artifact;
 * the CLI's `watch`/tail just prints back whatever is stored, since by the time an
 * objective finishes, the process that submitted it may be long gone.
 */

export interface AttemptSummary {
  attempt: number;
  exitReason: RunExitReason;
  turns: number;
  usage: TokenUsage;
  costUsdEstimate: number;
  verify?: VerifyOutcome;
}

export interface RunReportArgs {
  taskTitle: string;
  intent: string;
  attempts: AttemptSummary[];
  finalStatus: "done" | "failed";
  branch: string;
  worktreePath: string;
  committed: boolean;
}

function fmtUsage(u: TokenUsage): string {
  const total = u.input + u.output + u.cacheRead + u.cacheCreation;
  return `${total.toLocaleString()} tokens (in ${u.input.toLocaleString()}, out ${u.output.toLocaleString()}, cache read ${u.cacheRead.toLocaleString()})`;
}

export function renderReport(args: RunReportArgs): string {
  const lines: string[] = [];
  const totalCost = args.attempts.reduce((n, a) => n + a.costUsdEstimate, 0);
  const totalTurns = args.attempts.reduce((n, a) => n + a.turns, 0);

  lines.push("");
  lines.push("#".repeat(72));
  lines.push(`# ${args.taskTitle}`);
  lines.push("#".repeat(72));
  lines.push(`Status:     ${args.finalStatus.toUpperCase()}`);
  lines.push(`Attempts:   ${args.attempts.length}`);
  lines.push(`Turns:      ${totalTurns}`);
  lines.push(`Est. cost:  $${totalCost.toFixed(4)} (notional — subscription, not billed per token)`);
  lines.push(`Branch:     ${args.branch}`);
  lines.push(`Worktree:   ${args.worktreePath}`);
  lines.push(`Committed:  ${args.committed ? "yes" : "no"}`);
  lines.push("");
  lines.push("## Intent");
  lines.push(args.intent);
  lines.push("");
  lines.push("## Attempts");

  for (const a of args.attempts) {
    lines.push("");
    lines.push(`### Attempt ${a.attempt} — ${a.exitReason}`);
    lines.push(`  turns: ${a.turns}   ${fmtUsage(a.usage)}   cost: $${a.costUsdEstimate.toFixed(4)}`);
    if (a.verify) {
      for (const check of a.verify.checks) {
        const mark = check.passed ? "PASS" : "FAIL";
        lines.push(`  [${mark}] ${check.label}  (exit ${check.exitCode ?? "n/a"}, ${check.durationMs}ms)`);
        if (!check.passed) {
          const detail = (check.runError ?? check.stderr ?? check.stdout ?? "").trim();
          if (detail) {
            lines.push(
              "    " +
                detail
                  .split("\n")
                  .slice(0, 6)
                  .join("\n    "),
            );
          }
        }
      }
    }
  }

  lines.push("");
  lines.push("#".repeat(72));
  lines.push("");
  return lines.join("\n");
}
