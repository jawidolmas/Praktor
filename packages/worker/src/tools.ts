import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import {
  CheckPolicyInput,
  RecordFindingInput,
  ReportProgressInput,
  RequestDecisionInput,
  type CheckPolicyInput as CheckPolicyInputT,
  type Policy,
  type RecordFindingInput as RecordFindingInputT,
  type ReportProgressInput as ReportProgressInputT,
  type RequestDecisionInput as RequestDecisionInputT,
} from "@exec/core";
import { evaluate } from "@exec/policy";

/**
 * The supervisor's in-process MCP tools.
 *
 * This is what makes escalation a typed tool call instead of prose the supervisor
 * has to detect: a worker that wants to escalate calls `request_decision` and gets
 * a schema-validated request. There is no ambiguity about whether it was really
 * asking for something, and no transcript parsing on the supervisor side.
 */

export interface SupervisorToolCallbacks {
  /** Resolves once a human (or a policy) has answered. The worker's turn blocks
   *  on this call, which is the point — a genuine fork should stop the work. */
  requestDecision: (
    input: RequestDecisionInputT,
  ) => Promise<{ answer: string; answeredBy: string }>;
  reportProgress: (input: ReportProgressInputT) => void;
  recordFinding: (input: RecordFindingInputT) => void;
  loadPolicies: () => Policy[];
}

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

export function createSupervisorTools(callbacks: SupervisorToolCallbacks) {
  const requestDecisionTool = tool(
    "request_decision",
    "Escalate a genuine fork in the road to the person supervising this work — a " +
      "choice with real consequences where you cannot pick confidently on your own. " +
      "This call blocks until answered. Do not use it for routine implementation " +
      "choices you are equipped to make yourself.",
    RequestDecisionInput.shape,
    async (input: RequestDecisionInputT) => {
      const { answer, answeredBy } = await callbacks.requestDecision(input);
      return text(
        `Decision recorded: option ${answer} (answered by ${answeredBy}). Proceed accordingly.`,
      );
    },
  );

  const reportProgressTool = tool(
    "report_progress",
    "Report a milestone you just completed. Does not block. Call this when you " +
      "finish a meaningful unit of work, and once more with a final summary when " +
      "you believe the task is done or you are stuck.",
    ReportProgressInput.shape,
    async (input: ReportProgressInputT) => {
      callbacks.reportProgress(input);
      return text("Logged.");
    },
  );

  const checkPolicyTool = tool(
    "check_policy",
    "Ask whether an action you are about to take is restricted, before attempting " +
      "it. Use this when you suspect something might be off-limits rather than " +
      "finding out by having it denied.",
    CheckPolicyInput.shape,
    async (input: CheckPolicyInputT) => {
      const verdict = evaluate(callbacks.loadPolicies(), {
        tool: "Bash",
        input: { command: input.command ?? input.action },
      });
      if (verdict.action === "deny" || verdict.action === "ask") {
        return text(
          `Restricted: ${verdict.reason}. Do not proceed. If the task genuinely ` +
            `requires this, call request_decision instead of attempting it anyway.`,
        );
      }
      return text(`Clear to proceed: ${verdict.reason}`);
    },
  );

  const recordFindingTool = tool(
    "record_finding",
    "Record something out of scope you noticed along the way, for the backlog. " +
      "Does not block and does not change what you are doing right now.",
    RecordFindingInput.shape,
    async (input: RecordFindingInputT) => {
      callbacks.recordFinding(input);
      return text("Recorded for the backlog. Continue with the current task.");
    },
  );

  return createSdkMcpServer({
    name: "exec",
    version: "0.1.0",
    tools: [
      requestDecisionTool,
      reportProgressTool,
      checkPolicyTool,
      recordFindingTool,
    ],
  });
}
