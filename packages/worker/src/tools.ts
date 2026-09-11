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

/**
 * How a raised decision was resolved. "timed_out" is not an error — it means
 * nobody answered within the decision's deadline, so the caller should stop
 * this session rather than keep a worker (and its subprocess) idling on a
 * promise that might not resolve for hours. `decisionKey` on that variant is
 * what lets the attempt that eventually resumes wait on the same decision
 * instead of raising a new one.
 */
export type RequestDecisionResolution =
  | { outcome: "answered"; answer: string; answeredBy: string }
  | { outcome: "timed_out"; decisionKey: string };

export interface SupervisorToolCallbacks {
  /** Resolves once a human answers, or once the decision's deadline passes
   *  unanswered. The worker's turn blocks on this call either way — a
   *  genuine fork should stop the work, one way or the other. */
  requestDecision: (
    input: RequestDecisionInputT,
  ) => Promise<RequestDecisionResolution>;
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
    "Ask, notify, message, or check in with the person supervising this work, and " +
      "wait for their answer — delivered to them directly (e.g. a push " +
      "notification to their phone via Telegram), not just written to a file or " +
      "left as a note. Use this whenever the objective itself asks you to ask, " +
      "check with, confirm with, or get input from them about anything, no matter " +
      "how small — that instruction is what makes it not a routine choice you are " +
      "equipped to make yourself — and for any other genuine fork in the road with " +
      "real consequences where you cannot pick confidently on your own. This call " +
      "blocks until answered; there is no other way to actually reach them from " +
      "here, so do not substitute your own guess or a comment explaining that you " +
      "can't reach them.",
    RequestDecisionInput.shape,
    async (input: RequestDecisionInputT) => {
      const resolution = await callbacks.requestDecision(input);
      if (resolution.outcome === "timed_out") {
        return text(
          "No one answered in time, so this session is stopping now rather than continuing " +
            "to wait idle. It will resume automatically, told the answer, once the decision " +
            "is made — nothing more to do here.",
        );
      }
      return text(
        `Decision recorded: option ${resolution.answer} (answered by ${resolution.answeredBy}). ` +
          "Proceed accordingly.",
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
