import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { newId } from "@exec/core";
import { answerDecision, decisions, objectives, openDb, readEvents, runMigrations, tasks, type Db } from "@exec/db";
import { APP_ANSWERED_BY, applyAnswer, processAnswers, type AnswerInbox, type PendingAnswer } from "./answers.js";

const BUDGET = { maxTurns: 1, maxTokens: 1, maxWallClockMs: 1 };
const OPTIONS = [
  { id: "A", label: "Retry", pros: [], cons: [] },
  { id: "B", label: "Skip", pros: [], cons: [] },
];

let db: Db;
let decisionId: string;
let taskId: string;

function pending(answer = "A", id = "ans-1"): PendingAnswer {
  return { id, decision_id: decisionId, decision_key: "DEC-1", answer };
}

beforeEach(() => {
  db = openDb({ path: ":memory:" }).db;
  runMigrations(db);
  const objectiveId = newId();
  taskId = newId();
  decisionId = newId();
  db.insert(objectives).values({ id: objectiveId, title: "o", repoPath: "/r", budget: BUDGET, status: "blocked" }).run();
  db.insert(tasks)
    .values({
      id: taskId, objectiveId, key: "T-001", title: "t", intent: "x", taskClass: "implement",
      acceptance: { checks: [] }, budget: BUDGET, status: "blocked",
    })
    .run();
  db.insert(decisions)
    .values({
      id: decisionId, key: "DEC-1", objectiveId, taskId, level: "L2", title: "?", context: "",
      options: OPTIONS, recommendation: "A", risk: "low", blockedTaskIds: [taskId],
    })
    .run();
});

const decision = () => db.select().from(decisions).where(eq(decisions.id, decisionId)).get()!;

describe("applyAnswer", () => {
  it("applies through the same path as every other channel", () => {
    expect(applyAnswer(db, pending("B"))).toEqual({ status: "applied", message: "Applied." });
    expect(decision()).toMatchObject({ status: "answered", answer: "B", answeredBy: APP_ANSWERED_BY });
    // Same side effects as the CLI / Telegram: the blocked task is freed and
    // the answer lands in the audit log.
    expect(db.select().from(tasks).where(eq(tasks.id, taskId)).get()!.status).toBe("pending");
    expect(readEvents(db, {}).map((e) => e.payload.type)).toContain("decision.answered");
  });

  it("loses to an answer that got there first, and says where it came from", () => {
    answerDecision(db, { key: "DEC-1", answer: "A", answeredBy: "telegram:jawid" });
    expect(applyAnswer(db, pending("B"))).toEqual({ status: "rejected", message: "It was already answered in Telegram." });
    expect(decision().answer).toBe("A");
  });

  it("treats its own earlier, unreported application as applied (crash between apply and settle)", () => {
    applyAnswer(db, pending("A"));
    expect(applyAnswer(db, pending("A"))).toEqual({ status: "applied", message: "Applied." });
  });

  it("refuses an option the decision doesn't have", () => {
    expect(applyAnswer(db, pending("Z")).status).toBe("rejected");
    expect(decision().status).toBe("open");
  });

  it("refuses a decision that isn't on this computer", () => {
    expect(applyAnswer(db, { ...pending(), decision_id: "nope" }).status).toBe("rejected");
  });

  it("refuses a decision that expired or was withdrawn", () => {
    db.update(decisions).set({ status: "withdrawn" }).run();
    expect(applyAnswer(db, pending()).message).toMatch(/no longer open/);
  });
});

describe("processAnswers", () => {
  it("settles every pending answer and counts the applied ones", async () => {
    const settled: [string, string][] = [];
    const inbox: AnswerInbox = {
      pending: async () => [pending("A", "ans-1"), pending("B", "ans-2")],
      settle: async (id, status) => {
        settled.push([id, status]);
      },
    };
    expect(await processAnswers(db, inbox)).toBe(1);
    expect(settled).toEqual([
      ["ans-1", "applied"],
      ["ans-2", "rejected"],
    ]);
  });
});
