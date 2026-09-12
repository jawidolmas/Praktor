import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { DecomposeOutput, type DecomposeOutput as DecomposeOutputT } from "@exec/core";
import { buildRepoBriefing, renderBriefing } from "./briefing.js";

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
 * repo, so there is nothing to negotiate.
 */

export interface DecomposeArgs {
  title: string;
  brief: string;
  /** The real repo, not a worktree — no attempt (and so no worktree) exists
   *  yet at planning time. */
  repoPath: string;
  model: string;
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
  "Call submit_plan exactly once, when the graph is ready. Do not edit, write, or run " +
  "anything — you are only planning, not implementing.";

export function buildPlannerPrompt(args: DecomposeArgs, briefing: string): string {
  return [briefing, `Objective: ${args.title}`, args.brief, PLANNER_INSTRUCTIONS]
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
  const options: Options = {
    cwd: args.repoPath,
    model: args.model,
    permissionMode: "default",
    maxTurns: 8,
    disallowedTools: ["Edit", "Write", "NotebookEdit", "Bash"],
    mcpServers: { planner: plannerServer },
  };

  const q = query({ prompt: buildPlannerPrompt(args, briefing), options });

  let stopping = false;
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
  }

  if (!captured) {
    throw new Error("The planner finished without calling submit_plan.");
  }
  return { plan: captured, durationMs: Date.now() - startedAt };
}
