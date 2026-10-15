import { eq } from "drizzle-orm";
import { answerDecision, decisions, type Db } from "@exec/db";

/**
 * Applies decision answers sent from the phone. Every answer goes through
 * `answerDecision` — the exact path the CLI and dashboard use — so
 * the phone gets no special powers: the same "still open?" check, the same
 * task unblocking, the same audit event. The first answer from any channel
 * wins; a later one is refused and the phone is told why.
 */

/** How phone answers are attributed, locally and in the audit log. */
export const APP_ANSWERED_BY = "app";

export interface PendingAnswer {
  id: string;
  decision_id: string;
  decision_key: string;
  answer: string;
}

export interface AnswerInbox {
  pending(): Promise<PendingAnswer[]>;
  settle(id: string, status: "applied" | "rejected", message: string): Promise<void>;
}

export interface AnswerOutcome {
  status: "applied" | "rejected";
  message: string;
}

/** Where an earlier answer came from, in words for the phone. */
function channel(answeredBy: string | null): string {
  const by = answeredBy ?? "";
  if (by.startsWith("telegram")) return " in Telegram";
  if (by === "dashboard") return " on the dashboard";
  if (by.includes("cli") || by.includes("terminal")) return " in the terminal";
  return "";
}

export function applyAnswer(db: Db, a: PendingAnswer): AnswerOutcome {
  const local = db.select().from(decisions).where(eq(decisions.id, a.decision_id)).get();
  if (!local) return { status: "rejected", message: "This decision isn’t on that computer anymore." };

  if (local.status === "answered") {
    // Our own earlier attempt: applied, but the PC stopped before reporting
    // back. Report it as applied rather than as a conflict with itself.
    if (local.answer === a.answer && local.answeredBy === APP_ANSWERED_BY) {
      return { status: "applied", message: "Applied." };
    }
    return { status: "rejected", message: `It was already answered${channel(local.answeredBy)}.` };
  }
  if (local.status !== "open") return { status: "rejected", message: "This decision is no longer open." };
  if (!local.options.some((o) => o.id === a.answer)) {
    return { status: "rejected", message: "That isn’t one of the options." };
  }

  const applied = answerDecision(db, { key: local.key, answer: a.answer, answeredBy: APP_ANSWERED_BY });
  return applied
    ? { status: "applied", message: "Applied." }
    : { status: "rejected", message: "It was answered somewhere else a moment ago." };
}

/** Applies every pending answer; returns how many were applied, so the
 *  caller can sync the result straight back to the phone. */
export async function processAnswers(db: Db, inbox: AnswerInbox): Promise<number> {
  let applied = 0;
  for (const a of await inbox.pending()) {
    const outcome = applyAnswer(db, a);
    await inbox.settle(a.id, outcome.status, outcome.message);
    if (outcome.status === "applied") applied += 1;
  }
  return applied;
}
