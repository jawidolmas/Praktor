import { createSdkMcpServer, query, tool, type Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/**
 * Not every message is work. Before a message from the phone starts an
 * objective, decide what kind of message it is:
 *
 *   task     something to do in the repo — start the work, as before.
 *   chat     thanks, praise, an acknowledgement — reply, start nothing.
 *   unclear  outside what a coding supervisor can do ("bring me water"), or
 *            too vague to act on — reply with what Praktor *can* do.
 *
 * The commonest acknowledgements are recognized here for free, with no
 * model call. Anything else goes to a small, fast model with no tools and no
 * file access: it can only classify and write a one- or two-sentence reply.
 */

export type TriageKind = "task" | "chat" | "unclear";

export interface Triage {
  kind: TriageKind;
  /** Praktor's reply, for chat / unclear. */
  reply?: string;
}

const ACKNOWLEDGEMENTS = new Set([
  "thanks",
  "thank you",
  "thanks a lot",
  "thank you so much",
  "thanks so much",
  "many thanks",
  "thx",
  "ty",
  "tysm",
  "cheers",
  "great",
  "great job",
  "great work",
  "good job",
  "good work",
  "nice",
  "nice work",
  "nice job",
  "well done",
  "awesome",
  "amazing",
  "perfect",
  "excellent",
  "love it",
  "cool",
  "ok",
  "okay",
  "k",
  "got it",
  "sounds good",
  "all good",
  "lgtm",
  "looks good",
  "done",
  "👍",
  "🙏",
  "❤️",
]);

const CHAT_REPLIES = [
  "You’re welcome! Tell me whenever there’s something else to do — I’ll take it from there.",
  "Glad that worked out. Whenever you have the next thing, just say it here.",
  "Happy to help. Send the next task whenever you’re ready, then go and chill.",
];

/** The reply for anything Praktor can't act on. */
export const UNCLEAR_REPLY =
  "Seems like there’s nothing for me to do there — I work on the code in your repos. Tell me what you’d like changed, then go and chill.";

/** Recognizes the commonest acknowledgements without a model call. */
export function quickTriage(message: string): Triage | undefined {
  const normalized = message
    .toLowerCase()
    .replace(/[!.,?~]+/g, " ")
    .replace(/\s+(praktor|buddy|man|mate)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || normalized.split(" ").length > 5) return undefined;
  if (!ACKNOWLEDGEMENTS.has(normalized)) return undefined;
  // Same message, same reply — stable rather than random.
  const pick = [...normalized].reduce((n, ch) => n + ch.charCodeAt(0), 0) % CHAT_REPLIES.length;
  return { kind: "chat", reply: CHAT_REPLIES[pick]! };
}

const TriageOutput = z.object({
  kind: z.enum(["task", "chat", "unclear"]),
  reply: z.string().max(400).optional(),
});

export function buildTriagePrompt(message: string, repoName: string, earlier: string[]): string {
  const history = earlier.length
    ? `Earlier messages in this conversation, oldest first:\n${earlier.map((m, i) => `${i + 1}. ${m.slice(0, 300)}`).join("\n")}\n\n`
    : "";
  return (
    `You are the front desk of Praktor, a supervisor that runs coding agents on the person's own computer, ` +
    `in their git repo "${repoName}". Classify the person's newest message and call submit_triage once.\n\n` +
    `- "task": anything that asks for work in the repo — writing, changing, fixing, explaining, reviewing, ` +
    `researching for the code, even if short, vague-but-actionable, or a follow-up like "now add tests". ` +
    `When in doubt between task and anything else, choose task.\n` +
    `- "chat": thanks, praise, greetings, acknowledgements, small talk — nothing to do. Write a warm, ` +
    `brief reply (one or two sentences) inviting the next task.\n` +
    `- "unclear": something a coding supervisor cannot do (physical errands, unrelated real-world requests) ` +
    `or too empty to act on. Reply in one or two sentences, friendly, saying what Praktor can do instead.\n\n` +
    `Never promise to do work in a chat or unclear reply. Plain text, no markdown.\n\n` +
    `${history}Newest message:\n"""\n${message.slice(0, 2000)}\n"""`
  );
}

/** Classifies a message. Throws on failure — the caller decides the
 *  fallback (treating it as a task, so a real request is never dropped). */
export async function triage(args: {
  message: string;
  repoName: string;
  earlier: string[];
  cwd: string;
  model?: string;
}): Promise<Triage> {
  const quick = quickTriage(args.message);
  if (quick) return quick;

  let captured: z.infer<typeof TriageOutput> | undefined;
  const submit = tool("submit_triage", "Submit the classification. Call exactly once.", TriageOutput.shape, async (input) => {
    captured = TriageOutput.parse(input);
    return { content: [{ type: "text" as const, text: "Received." }] };
  });
  const options: Options = {
    cwd: args.cwd,
    model: args.model ?? "haiku",
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: 3,
    mcpServers: { triage: createSdkMcpServer({ name: "triage", version: "0.1.0", tools: [submit] }) },
    // Classification only: no file, shell or web access of any kind.
    disallowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "NotebookEdit", "Task", "TodoWrite"],
  };

  const q = query({ prompt: buildTriagePrompt(args.message, args.repoName, args.earlier), options });
  for await (const msg of q) {
    if (captured) {
      await q.interrupt().catch(() => {});
      break;
    }
    if (msg.type === "result") break;
  }
  if (!captured) throw new Error("triage finished without a classification");
  if (captured.kind === "task") return { kind: "task" };
  const reply = captured.reply?.trim();
  return {
    kind: captured.kind,
    reply: reply && reply.length > 0 ? reply : captured.kind === "chat" ? CHAT_REPLIES[0]! : UNCLEAR_REPLY,
  };
}
