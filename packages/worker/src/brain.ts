import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import {
  DecomposeOutput,
  DiagnoseOutput,
  ReviewOutput,
  type DecomposeOutput as DecomposeOutputT,
  type DiagnoseOutput as DiagnoseOutputT,
  type ReviewOutput as ReviewOutputT,
  type TokenUsage,
} from "@exec/core";
import { buildRepoBriefing, renderBriefing } from "./briefing.js";
import { renderEngineeringProfile, type ProfileEntry } from "./profile.js";
import { diffPatch } from "./worktree.js";
import type { StallSignal } from "./telemetry.js";
import type { VerifyOutcome } from "./verify.js";

const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

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

/**
 * The planner brain call: turns a plain-English objective into a
 * dependency-ordered task graph, instead of the one-task-per-objective shape
 * `apps/cli`'s `do` command was limited to before this existed.
 *
 * Structured output is enforced the same way the rest of the supervisor's
 * escalation channel is (see `tools.ts`): not a whole-session response
 * schema — the SDK has no such thing for the plain `query()` API — but a
 * single in-process MCP tool (`submit_plan`) whose input schema *is*
 * `DecomposeOutput`. The planner has exactly one way to finish successfully:
 * call it. Anything else (talking without calling it, running out of turns)
 * is treated as a failed brain call, not a malformed one.
 *
 * Deliberately not a full worker session: no worktree, no supervisor tools,
 * no policy hook, and file-mutating tools are disallowed outright rather than
 * merely policed — a planning call has no legitimate reason to touch the
 * repo, so there is nothing to negotiate. That's also why this runs with
 * `bypassPermissions` rather than `driver.ts`'s `default` + policy hook: with
 * no hook installed to answer them, "default" leaves every tool call — even
 * a harmless Read — waiting on a permission prompt nothing will ever answer
 * inside a headless daemon. Confirmed live: that hang doesn't just stall this
 * one objective, it wedges the whole daemon, since the main loop awaits
 * planning before it will look at anything else. `disallowedTools` is what
 * actually keeps this safe to bypass — the tools that would matter are never
 * reachable in the first place. The wall-clock budget below is the backstop
 * for any *other* way a brain call could hang: this must always eventually
 * give up and fall back, never sit blocking the daemon indefinitely.
 *
 * `effort` is set explicitly to "medium" — every other call site in this
 * codebase does the same, and leaving it unset here was itself a bug: a
 * live run against a real, doc-heavy repo showed the SDK defaulting to
 * "xhigh" with no effort specified, burning 5,000+ thinking tokens per turn
 * on a task that only needs to skim a handful of files and propose a list —
 * it ran past both maxTurns and the wall-clock budget without ever reaching
 * submit_plan, purely from that reasoning overhead, not from any tool
 * discovery problem.
 */

const PLANNING_TIMEOUT_MS = 5 * 60_000;

export interface DecomposeArgs {
  title: string;
  brief: string;
  /** The real repo, not a worktree — no attempt (and so no worktree) exists
   *  yet at planning time. */
  repoPath: string;
  model: string;
  /** The standing engineering profile (permanent-tier memory), so the task
   *  graph itself gets planned around real preferences — e.g. a task that
   *  would otherwise casually introduce a new dependency or a new database
   *  is planned around "avoid unnecessary dependencies" from the start,
   *  rather than only being caught later at review time. Empty when nothing
   *  has been set. */
  profile?: ProfileEntry[];
}

export interface DecomposeResult {
  plan: DecomposeOutputT;
  durationMs: number;
}

const PLANNER_INSTRUCTIONS =
  "Break the objective above into a dependency-ordered task graph for a team that will " +
  "implement it one task at a time, each in its own isolated git worktree with no memory " +
  "of any other task except what its own acceptance checks prove passed. Requirements:\n" +
  "- Every task must be independently verifiable: each acceptance check is a real shell " +
  "command that will actually be run in this repo — one that always exits 0 is not a check.\n" +
  "- Set dependsOn so nothing is asked to build on work that has not happened yet.\n" +
  "- Keep tasks as small as you can while each stays independently verifiable — several " +
  "small tasks recover from one bad attempt far better than one large task does.\n" +
  "- If the objective is genuinely a single indivisible step, return exactly one task.\n" +
  "- Prefer checks that ask a real question about behavior (run the tests, run the linter, " +
  "grep for a symbol, check a file exists) over a raw byte-for-byte diff against a reference " +
  "file — line-ending or whitespace differences that mean nothing can still make a literal " +
  "diff fail on content that is otherwise correct.\n" +
  "You have a limited number of turns for this — skim only what you need to plan " +
  "confidently (the files the objective itself points at, plus anything they reference), " +
  "not every file in the repo. A good plan from a quick, targeted look beats no plan " +
  "because time ran out on a thorough one.\n" +
  "Call submit_plan exactly once, when the graph is ready. Do not edit, write, or run " +
  "anything — you are only planning, not implementing.";

export function buildPlannerPrompt(args: DecomposeArgs, briefing: string): string {
  return [
    briefing,
    renderEngineeringProfile(args.profile ?? []),
    `Objective: ${args.title}`,
    args.brief,
    PLANNER_INSTRUCTIONS,
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

export async function decompose(args: DecomposeArgs): Promise<DecomposeResult> {
  const startedAt = Date.now();
  let captured: DecomposeOutputT | undefined;

  const submitPlanTool = tool(
    "submit_plan",
    "Submit the finished task graph for this objective. Call this exactly once, when " +
      "you are done planning.",
    DecomposeOutput.shape,
    async (input) => {
      captured = DecomposeOutput.parse(input);
      return { content: [{ type: "text" as const, text: "Plan received." }] };
    },
  );
  const plannerServer = createSdkMcpServer({
    name: "planner",
    version: "0.1.0",
    tools: [submitPlanTool],
  });

  const briefing = renderBriefing(buildRepoBriefing(args.repoPath));
  const abortController = new AbortController();
  const options: Options = {
    cwd: args.repoPath,
    model: args.model,
    effort: "medium",
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: 20,
    abortController,
    disallowedTools: ["Edit", "Write", "NotebookEdit", "Bash"],
    mcpServers: { planner: plannerServer },
  };

  const q = query({ prompt: buildPlannerPrompt(args, briefing), options });

  let stopping = false;
  const timeout = setTimeout(() => {
    stopping = true;
    abortController.abort();
  }, PLANNING_TIMEOUT_MS);

  try {
    for await (const msg of q) {
      if (msg.type === "result") break;
      if (!stopping && captured) {
        stopping = true;
        await q.interrupt().catch(() => {
          /* best effort — we keep draining the generator either way */
        });
      }
    }
  } catch (err) {
    if (!stopping) throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!captured) {
    throw new Error("The planner finished without calling submit_plan.");
  }
  return { plan: captured, durationMs: Date.now() - startedAt };
}

/* ------------------------------------------------------------------ *
 * The judge: did the work actually satisfy the intent?
 * ------------------------------------------------------------------ */

/**
 * The judge brain call — the piece that makes "Praktor declares victory,
 * not the worker" true. Runs only after mechanical acceptance has already
 * passed (engine.ts enforces this ordering): acceptance answers "does the
 * repo do what the checks say," this answers "is that actually what the
 * task asked for" — a question no shell command's exit code can ever
 * express. A worker that hits every acceptance check while quietly
 * ignoring half the intent, or editing files nothing in the intent
 * mentions, passes the first gate and fails this one.
 *
 * Deliberately a fresh, independent session with no memory of the attempt
 * that produced the diff — grading your own homework from inside the same
 * context that wrote it is not independent review. Read-only for the same
 * reason `decompose` is: judging is not implementing, so there is nothing
 * to negotiate about Edit/Write/Bash access.
 */

const REVIEW_TIMEOUT_MS = 5 * 60_000;

export interface ReviewArgs {
  taskTitle: string;
  intent: string;
  /** The attempt's worktree — reviewed in place so the judge can Read/Grep
   *  the real files the diff touches, not just the patch text. */
  worktreePath: string;
  baseSha: string;
  verify: VerifyOutcome;
  model: string;
  /** The standing engineering profile — see `DecomposeArgs.profile`. Here,
   *  it's what lets the judge reject a diff that technically satisfies the
   *  intent but violates a standing preference (an unnecessary dependency,
   *  a needless abstraction) — the acceptance checks structurally cannot
   *  express that, and the worker has no reason to know it unprompted. */
  profile?: ProfileEntry[];
}

export interface ReviewResult {
  review: ReviewOutputT;
  durationMs: number;
  usage: TokenUsage;
  costUsdEstimate: number;
}

function renderVerifySummary(verify: VerifyOutcome): string {
  return verify.checks
    .map((c) => `- ${c.label} (${c.command}): ${c.passed ? "passed" : `FAILED, exit ${c.exitCode}`}`)
    .join("\n");
}

const REVIEWER_INSTRUCTIONS =
  "You are reviewing one finished task, not implementing anything. Its mechanical acceptance " +
  "checks already passed — your job is the question those checks cannot ask: does this diff " +
  "actually do what the intent below asked for, in a way a reasonable person would call done?\n" +
  "Specifically check for:\n" +
  "- Requirements stated or clearly implied by the intent that the diff does not address.\n" +
  "- Files changed that have nothing to do with the intent — acceptance checks only prove the " +
  "target behavior exists, not that nothing unrelated was touched.\n" +
  "- A change that is locally plausible but globally wrong for this repo (contradicts an " +
  "existing pattern, duplicates something that already exists, or solves a narrower or " +
  "different problem than what was asked).\n" +
  "- A violation of the standing engineering profile below, if one is given, even when the " +
  "diff otherwise satisfies the intent — e.g. an unnecessary dependency or abstraction the " +
  "profile says to avoid is a real reason to send this back, not a stylistic nitpick.\n" +
  "You may Read and Grep the actual files, not just the diff text, before deciding.\n" +
  "Use 'accept' only when you would be comfortable this task never gets looked at again. Use " +
  "'revise' when it is close but something concrete is missing or wrong. Use 'reject' when it " +
  "does not address the intent at all. List every concrete reason — a respawned worker only " +
  "sees what you write here, not your reasoning.\n" +
  "Call submit_review exactly once, when you have decided. Do not edit, write, or run anything.";

export function buildReviewerPrompt(args: ReviewArgs, briefing: string, patch: string): string {
  return [
    briefing,
    renderEngineeringProfile(args.profile ?? []),
    `Task: ${args.taskTitle}`,
    `Intent: ${args.intent}`,
    `Acceptance checks (already passed):\n${renderVerifySummary(args.verify)}`,
    `Diff since the base commit:\n\`\`\`diff\n${patch || "(no diff — nothing changed on disk)"}\n\`\`\``,
    REVIEWER_INSTRUCTIONS,
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

export async function review(args: ReviewArgs): Promise<ReviewResult> {
  const startedAt = Date.now();
  let captured: ReviewOutputT | undefined;
  let usage = ZERO_USAGE;
  let costUsdEstimate = 0;

  const submitReviewTool = tool(
    "submit_review",
    "Submit your verdict on this finished task. Call this exactly once, when you have decided.",
    ReviewOutput.shape,
    async (input) => {
      captured = ReviewOutput.parse(input);
      return { content: [{ type: "text" as const, text: "Review received." }] };
    },
  );
  const reviewerServer = createSdkMcpServer({
    name: "reviewer",
    version: "0.1.0",
    tools: [submitReviewTool],
  });

  const briefing = renderBriefing(buildRepoBriefing(args.worktreePath));
  const patch = diffPatch(args.worktreePath, args.baseSha);
  const abortController = new AbortController();
  const options: Options = {
    cwd: args.worktreePath,
    model: args.model,
    effort: "medium",
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: 15,
    abortController,
    disallowedTools: ["Edit", "Write", "NotebookEdit", "Bash"],
    mcpServers: { reviewer: reviewerServer },
  };

  const q = query({ prompt: buildReviewerPrompt(args, briefing, patch), options });

  let stopping = false;
  const timeout = setTimeout(() => {
    stopping = true;
    abortController.abort();
  }, REVIEW_TIMEOUT_MS);

  try {
    for await (const msg of q) {
      if (msg.type === "assistant") {
        usage = toTokenUsage(msg.message.usage);
      }
      if (msg.type === "result") {
        costUsdEstimate = msg.total_cost_usd;
        break;
      }
      if (!stopping && captured) {
        stopping = true;
        await q.interrupt().catch(() => {
          /* best effort — we keep draining the generator either way */
        });
      }
    }
  } catch (err) {
    if (!stopping) throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!captured) {
    throw new Error("The reviewer finished without calling submit_review.");
  }
  return { review: captured, durationMs: Date.now() - startedAt, usage, costUsdEstimate };
}

/* ------------------------------------------------------------------ *
 * The diagnoser: why did this attempt fail, and what should happen next?
 * ------------------------------------------------------------------ */

/**
 * Classifies a failed attempt (a stall, a failed acceptance check, or a
 * judge `revise`/`reject`) so the supervisor can react to *why* it failed
 * instead of always running the identical checkpoint-and-respawn loop.
 * A flaky failure deserves a plain retry; a task whose acceptance criteria
 * are internally contradictory deserves a person's attention immediately,
 * not three more respawns that fail the same way for the same reason.
 *
 * Same shape as `review`: fresh session, read-only, fails open — the
 * caller falls back to today's unconditional "respawn" behavior on any
 * error here, so a classifier outage is never a new way to get stuck.
 */

const DIAGNOSE_TIMEOUT_MS = 3 * 60_000;

export interface DiagnoseArgs {
  taskTitle: string;
  intent: string;
  worktreePath: string;
  model: string;
  ruledOut: string[];
  stallSignal?: StallSignal;
  verify?: VerifyOutcome;
  review?: ReviewOutputT;
  /** Fallback context when none of the three above narrow it down (e.g. the
   *  run ended in a plain SDK error) — the worker's own final result subtype. */
  exitReason?: string;
  /** The standing engineering profile — see `DecomposeArgs.profile`. Lets a
   *  hint (`retry_with_hint`) point a respawned worker toward the preferred
   *  approach, not just away from the one that just failed. */
  profile?: ProfileEntry[];
}

export interface DiagnoseResult {
  diagnosis: DiagnoseOutputT;
  durationMs: number;
  usage: TokenUsage;
  costUsdEstimate: number;
}

function renderFailureDetail(args: DiagnoseArgs): string {
  if (args.review && args.review.verdict !== "accept") {
    return (
      `Praktor's independent reviewer sent this back with verdict "${args.review.verdict}":\n` +
      `${args.review.reasons.join("\n") || "(no reasons given)"}\n` +
      (args.review.missing.length > 0 ? `Missing: ${args.review.missing.join("; ")}` : "")
    );
  }
  if (args.verify) {
    const failed = args.verify.checks.filter((c) => !c.passed);
    return `Acceptance checks failed:\n${failed
      .map((c) => `- ${c.label} (${c.command}): exit ${c.exitCode ?? "n/a"}\n  ${(c.runError ?? c.stderr ?? c.stdout ?? "").slice(0, 500)}`)
      .join("\n")}`;
  }
  if (args.stallSignal) {
    return `The worker stalled: ${args.stallSignal.signal} — ${args.stallSignal.detail}`;
  }
  return `The run ended without completing (${args.exitReason ?? "unknown reason"}), and no more specific detail was captured.`;
}

const DIAGNOSER_INSTRUCTIONS =
  "A task attempt just failed. Classify why, using only the evidence given — you may Read/Grep " +
  "the repo for context but the failure already happened in a worktree you are not looking at.\n" +
  "class: 'flaky' — looks like bad luck (e.g. a timing-dependent test, a transient network " +
  "error in a check) rather than anything wrong with the approach.\n" +
  "class: 'bug' — the approach was reasonable but has a real, fixable defect.\n" +
  "class: 'spec' — the task's own intent or acceptance checks are unclear, contradictory, or " +
  "ask for something that conflicts with the repo as it actually is. More attempts at THIS " +
  "task cannot fix a broken spec.\n" +
  "class: 'env' — the failure is about the environment/tooling (missing dependency, wrong " +
  "path, platform mismatch), not the code change itself.\n" +
  "nextAction: 'retry' for flaky (no hint needed, just try again). 'retry_with_hint' for a bug " +
  "you can name a concrete different approach for. 'respawn' when you're not confident enough " +
  "to give a specific hint but another attempt is still worth it. 'escalate' for 'spec' or a " +
  "'bug'/'env' problem too deep for another attempt to plausibly fix on its own — a person " +
  "should look. 'abandon' only when this task cannot succeed at all as written.\n" +
  "Call submit_diagnosis exactly once.";

export function buildDiagnoserPrompt(args: DiagnoseArgs, briefing: string): string {
  return [
    briefing,
    renderEngineeringProfile(args.profile ?? []),
    `Task: ${args.taskTitle}`,
    `Intent: ${args.intent}`,
    renderFailureDetail(args),
    args.ruledOut.length > 0 ? `Already ruled out in earlier attempts:\n${args.ruledOut.map((r) => `- ${r}`).join("\n")}` : "",
    DIAGNOSER_INSTRUCTIONS,
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

export async function diagnose(args: DiagnoseArgs): Promise<DiagnoseResult> {
  const startedAt = Date.now();
  let captured: DiagnoseOutputT | undefined;
  let usage = ZERO_USAGE;
  let costUsdEstimate = 0;

  const submitDiagnosisTool = tool(
    "submit_diagnosis",
    "Submit your classification of why this attempt failed and what should happen next. Call " +
      "this exactly once.",
    DiagnoseOutput.shape,
    async (input) => {
      captured = DiagnoseOutput.parse(input);
      return { content: [{ type: "text" as const, text: "Diagnosis received." }] };
    },
  );
  const diagnoserServer = createSdkMcpServer({
    name: "diagnoser",
    version: "0.1.0",
    tools: [submitDiagnosisTool],
  });

  const briefing = renderBriefing(buildRepoBriefing(args.worktreePath));
  const abortController = new AbortController();
  const options: Options = {
    cwd: args.worktreePath,
    model: args.model,
    effort: "medium",
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: 10,
    abortController,
    disallowedTools: ["Edit", "Write", "NotebookEdit", "Bash"],
    mcpServers: { diagnoser: diagnoserServer },
  };

  const q = query({ prompt: buildDiagnoserPrompt(args, briefing), options });

  let stopping = false;
  const timeout = setTimeout(() => {
    stopping = true;
    abortController.abort();
  }, DIAGNOSE_TIMEOUT_MS);

  try {
    for await (const msg of q) {
      if (msg.type === "assistant") {
        usage = toTokenUsage(msg.message.usage);
      }
      if (msg.type === "result") {
        costUsdEstimate = msg.total_cost_usd;
        break;
      }
      if (!stopping && captured) {
        stopping = true;
        await q.interrupt().catch(() => {
          /* best effort — we keep draining the generator either way */
        });
      }
    }
  } catch (err) {
    if (!stopping) throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!captured) {
    throw new Error("The diagnoser finished without calling submit_diagnosis.");
  }
  return { diagnosis: captured, durationMs: Date.now() - startedAt, usage, costUsdEstimate };
}
