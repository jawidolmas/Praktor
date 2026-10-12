import { beforeEach, describe, expect, it } from "vitest";
import { newId } from "@exec/core";
import { decisions, objectives, openDb, runMigrations, type Db } from "@exec/db";
import { collectNotices, processPush, sendExpoPush, type PushOutbox } from "./push.js";

const BUDGET = { maxTurns: 1, maxTokens: 1, maxWallClockMs: 1 };
const TOKEN = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
let db: Db;

function objective(status: string, updatedAt: number, mergedAt: number | null = null): string {
  const id = newId();
  db.insert(objectives).values({ id, title: `obj ${status}`, repoPath: "/r", budget: BUDGET, status, updatedAt, mergedAt }).run();
  return id;
}

function decision(createdAt: number, status = "open"): string {
  const id = newId();
  db.insert(decisions)
    .values({
      id, key: `DEC-${id.slice(0, 4)}`, objectiveId: "o", level: "L2", title: "Phone or Computer?", context: "",
      options: [], recommendation: "A", risk: "low", status, createdAt,
    })
    .run();
  return id;
}

/** A fake Expo endpoint: records what was sent, answers with tickets. */
function fakeExpo(tickets?: (msgs: { to: string }[]) => unknown[]) {
  const sent: { to: string; title: string; body: string; data: { url: string } }[] = [];
  let failNext = false;
  const fetchImpl = async (_url: string, init: { body: string }) => {
    if (failNext) {
      failNext = false;
      return { ok: false, status: 503, json: async () => ({}) };
    }
    const msgs = JSON.parse(init.body);
    sent.push(...msgs);
    return { ok: true, status: 200, json: async () => ({ data: tickets ? tickets(msgs) : msgs.map(() => ({ status: "ok" })) }) };
  };
  return { sent, fetchImpl, failOnce: () => (failNext = true) };
}

function outbox(tokens: string[] = [TOKEN]): PushOutbox & { dropped: string[] } {
  const box = { dropped: [] as string[], tokens: async () => tokens, drop: async (t: string) => void box.dropped.push(t) };
  return box;
}

beforeEach(() => {
  db = openDb({ path: ":memory:" }).db;
  runMigrations(db);
});

describe("collectNotices", () => {
  it("covers open decisions, finished-unmerged work, and failures — after `since` only", () => {
    decision(5);
    const fresh = decision(20);
    decision(25, "answered");
    const ready = objective("done", 20);
    objective("done", 20, 30); // already merged
    const failed = objective("failed", 21);
    objective("active", 22);
    objective("done", 5); // before `since`

    const keys = collectNotices(db, 10).map((n) => n.key).sort();
    expect(keys).toEqual([`decision:${fresh}`, `failed:${failed}`, `ready:${ready}`].sort());
  });

  it("opens the matching screen, and never carries more than a title", () => {
    const id = decision(20);
    const [n] = collectNotices(db, 10);
    expect(n).toEqual({ key: `decision:${id}`, title: "Praktor needs a decision", body: "Phone or Computer?", url: `/decisions/${id}` });
  });
});

describe("processPush", () => {
  it("starts from now on the first pass, so history is never sent", async () => {
    decision(5);
    const expo = fakeExpo();
    expect(await processPush(db, outbox(), "h", { now: 10, fetchImpl: expo.fetchImpl })).toBe(0);
    expect(expo.sent).toEqual([]);
  });

  it("notifies once per thing, across passes", async () => {
    const expo = fakeExpo();
    await processPush(db, outbox(), "h", { now: 10, fetchImpl: expo.fetchImpl });
    decision(20);
    expect(await processPush(db, outbox(), "h", { now: 30, fetchImpl: expo.fetchImpl })).toBe(1);
    expect(await processPush(db, outbox(), "h", { now: 40, fetchImpl: expo.fetchImpl })).toBe(0);
    expect(expo.sent).toHaveLength(1);
  });

  it("retries on the next pass when Expo is unavailable, rather than losing it", async () => {
    const expo = fakeExpo();
    await processPush(db, outbox(), "h", { now: 10, fetchImpl: expo.fetchImpl });
    decision(20);
    expo.failOnce();
    await expect(processPush(db, outbox(), "h", { now: 30, fetchImpl: expo.fetchImpl })).rejects.toThrow(/503/);
    expect(await processPush(db, outbox(), "h", { now: 40, fetchImpl: expo.fetchImpl })).toBe(1);
  });

  it("doesn't replay what happened while no phone was registered", async () => {
    const expo = fakeExpo();
    await processPush(db, outbox([]), "h", { now: 10, fetchImpl: expo.fetchImpl });
    decision(20);
    await processPush(db, outbox([]), "h", { now: 30, fetchImpl: expo.fetchImpl });
    expect(await processPush(db, outbox(), "h", { now: 40, fetchImpl: expo.fetchImpl })).toBe(0);
    expect(expo.sent).toEqual([]);
  });

  it("drops a token Expo says is dead", async () => {
    const expo = fakeExpo((msgs) => msgs.map(() => ({ status: "error", details: { error: "DeviceNotRegistered" } })));
    const box = outbox();
    await processPush(db, box, "h", { now: 10, fetchImpl: expo.fetchImpl });
    decision(20);
    await processPush(db, box, "h", { now: 30, fetchImpl: expo.fetchImpl });
    expect(box.dropped).toEqual([TOKEN]);
  });
});

describe("sendExpoPush", () => {
  it("sends every notice to every phone, in batches of at most 100", async () => {
    const expo = fakeExpo();
    const tokens = Array.from({ length: 3 }, (_, i) => `ExponentPushToken[${"t".repeat(20)}${i}]`);
    const notices = Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, title: "t", body: "b", url: "/x" }));
    let calls = 0;
    await sendExpoPush(tokens, notices, async (url, init) => {
      calls += 1;
      expect(JSON.parse(init.body).length).toBeLessThanOrEqual(100);
      return expo.fetchImpl(url, init);
    });
    expect(expo.sent).toHaveLength(120);
    expect(calls).toBe(2);
  });
});
