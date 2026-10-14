import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { newId } from "@exec/core";
import { objectives, openDb, runMigrations, tasks, type Db } from "@exec/db";
import {
  conversationContext,
  localRepos,
  processRequests,
  repoKey,
  startFromRequest,
  type LocalRepo,
  type PendingRequest,
  type RequestInbox,
} from "./requests.js";

const REPO = mkdtempSync(join(tmpdir(), "praktor-req-"));
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

let db: Db;
beforeEach(() => {
  db = openDb({ path: ":memory:" }).db;
  runMigrations(db);
});

const repoMap = (): Map<string, LocalRepo> =>
  new Map([[repoKey(REPO), { key: repoKey(REPO), name: "takil-workspace", path: REPO, lastUsedAt: null }]]);

function fakeInbox(pending: PendingRequest[], earlier: { message: string; objective_id: string | null }[] = []) {
  const settled: { id: string; status: string; objectiveId: string | null; reason: string | null }[] = [];
  let failSettleOnce = false;
  const inbox: RequestInbox & { settled: typeof settled; failNextSettle: () => void } = {
    settled,
    failNextSettle: () => (failSettleOnce = true),
    pending: async () => pending.filter((p) => !settled.some((s) => s.id === p.id)),
    earlier: async () => earlier,
    settle: async (id, status, objectiveId, reason) => {
      if (failSettleOnce) {
        failSettleOnce = false;
        throw new Error("network down");
      }
      settled.push({ id, status, objectiveId, reason });
    },
  };
  return inbox;
}

const request = (message: string, id = newId()): PendingRequest => ({
  id,
  thread_id: "t1",
  repo_key: repoKey(REPO),
  message,
  created_at: new Date().toISOString(),
});

describe("repoKey", () => {
  it("is stable and opaque", () => {
    expect(repoKey("C:\\Users\\jawid\\Desktop\\x")).toBe(repoKey("C:/Users/jawid/Desktop/x/"));
    expect(repoKey("/a")).toMatch(/^[0-9a-f]{16}$/);
    expect(repoKey("/a")).not.toBe(repoKey("/b"));
  });
});

describe("startFromRequest — the same intake as `exec-agent do`", () => {
  it("gives an obviously single-step request a real check and starts it directly", () => {
    const id = startFromRequest(db, { repoPath: REPO, message: "add JAWID.md saying hello" });
    const o = db.select().from(objectives).where(eq(objectives.id, id)).get()!;
    expect(o.status).toBe("active");
    const [task] = db.select().from(tasks).where(eq(tasks.objectiveId, id)).all();
    expect(task!.acceptance.checks[0]!.label).toBe("JAWID.md exists");
  });

  it("sends anything bigger to the planner", () => {
    const id = startFromRequest(db, { repoPath: REPO, message: "refactor the auth module" });
    expect(db.select().from(objectives).where(eq(objectives.id, id)).get()!.status).toBe("draft");
  });

  it("titles it by the first line, and keeps the full message plus context as the brief", () => {
    const id = startFromRequest(db, { repoPath: REPO, message: "Fix the login bug\nIt crashes on empty passwords", context: "CTX" });
    const o = db.select().from(objectives).where(eq(objectives.id, id)).get()!;
    expect(o.title).toBe("Fix the login bug");
    expect(o.brief).toBe("Fix the login bug\nIt crashes on empty passwords\n\nCTX");
  });

  it("infers from the message only, never from earlier context", () => {
    const id = startFromRequest(db, { repoPath: REPO, message: "now make it faster", context: 'Earlier: "add NOTES.md"' });
    expect(db.select().from(objectives).where(eq(objectives.id, id)).get()!.status).toBe("draft");
  });
});

describe("conversationContext", () => {
  it("summarizes the conversation so far with each outcome", () => {
    const id = startFromRequest(db, { repoPath: REPO, message: "add NOTES.md" });
    db.update(objectives).set({ status: "done", mergedAt: 1 }).run();
    const ctx = conversationContext(db, [{ message: "add NOTES.md", objective_id: id }])!;
    expect(ctx).toContain('"add NOTES.md" (finished and merged)');
  });

  it("is absent for the first message", () => {
    expect(conversationContext(db, [])).toBeUndefined();
  });
});

describe("processRequests", () => {
  it("starts an objective and reports it back", async () => {
    const inbox = fakeInbox([request("add A.md")]);
    expect(await processRequests(db, inbox, repoMap)).toBe(1);
    expect(inbox.settled[0]).toMatchObject({ status: "started" });
    expect(db.select().from(objectives).all()).toHaveLength(1);
  });

  it("never starts the same request twice when the report back was lost", async () => {
    const r = request("add B.md");
    const inbox = fakeInbox([r]);
    inbox.failNextSettle();
    await expect(processRequests(db, inbox, repoMap)).rejects.toThrow(/network down/);
    await processRequests(db, inbox, repoMap);
    expect(db.select().from(objectives).all()).toHaveLength(1);
    expect(inbox.settled).toEqual([{ id: r.id, status: "started", objectiveId: db.select().from(objectives).get()!.id, reason: null }]);
  });

  it("refuses a repo this computer doesn't have", async () => {
    const inbox = fakeInbox([{ ...request("add C.md"), repo_key: "ffffffffffffffff" }]);
    await processRequests(db, inbox, repoMap);
    expect(inbox.settled[0]).toMatchObject({ status: "rejected" });
    expect(db.select().from(objectives).all()).toHaveLength(0);
  });

  it("passes the conversation so far to a follow-up", async () => {
    const first = startFromRequest(db, { repoPath: REPO, message: "add NOTES.md" });
    const inbox = fakeInbox([request("now add tests for it")], [{ message: "add NOTES.md", objective_id: first }]);
    await processRequests(db, inbox, repoMap);
    const followUp = db.select().from(objectives).all().find((o) => o.id !== first)!;
    expect(followUp.brief).toContain('"add NOTES.md"');
  });
});

describe("localRepos", () => {
  it("offers discovered repos and ones objectives already ran in, by name", () => {
    startFromRequest(db, { repoPath: REPO, message: "add D.md" });
    const repos = localRepos(db, () => []);
    expect([...repos.values()].map((r) => r.key)).toEqual([repoKey(REPO)]);
    expect([...repos.values()][0]!.lastUsedAt).not.toBeNull();
  });
});
