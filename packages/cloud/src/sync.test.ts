import { beforeEach, describe, expect, it } from "vitest";
import { newId } from "@exec/core";
import { appendEvent, decisions, objectives, openDb, runMigrations, runs, tasks, type Db } from "@exec/db";
import type { TaskFiles } from "./agent-files.js";
import { CloudSync, type CloudTable, type CloudWriter } from "./sync.js";

/** An in-memory relay: records every upsert in order, and can be told to
 *  fail on a given table to simulate a dropped connection mid-sync. */
class FakeRelay implements CloudWriter {
  calls: { table: CloudTable; rows: any[] }[] = [];
  heartbeats = 0;
  failOn: CloudTable | undefined;

  async upsert(table: CloudTable, rows: object[]): Promise<void> {
    if (this.failOn === table) throw new Error(`network down on ${table}`);
    this.calls.push({ table, rows: rows as any[] });
  }
  async heartbeat(): Promise<void> {
    this.heartbeats += 1;
  }
  rows(table: CloudTable): any[] {
    return this.calls.filter((c) => c.table === table).flatMap((c) => c.rows);
  }
  order(): CloudTable[] {
    return this.calls.map((c) => c.table);
  }
}

const BUDGET = { maxTurns: 1, maxTokens: 1, maxWallClockMs: 1 };
const STAMP = { owner_id: "owner-1", host_id: "host-1" };
const noFiles = (): TaskFiles[] => [];

let db: Db;
let relay: FakeRelay;

function addObjective(title = "Ship it", updatedAt = 1): string {
  const id = newId();
  db.insert(objectives)
    .values({ id, title, repoPath: "C:\\Users\\me\\Desktop\\praktor", budget: BUDGET, status: "active", createdAt: 1, updatedAt })
    .run();
  return id;
}

function addTask(objectiveId: string): string {
  const id = newId();
  db.insert(tasks)
    .values({
      id, objectiveId, key: "T-001", title: "task", intent: "x", taskClass: "implement",
      acceptance: { checks: [] }, budget: BUDGET, status: "running", attempts: 1,
    })
    .run();
  return id;
}

beforeEach(() => {
  db = openDb({ path: ":memory:" }).db;
  runMigrations(db);
  relay = new FakeRelay();
});

describe("CloudSync", () => {
  it("sends parents before children, so the relay's foreign keys hold", async () => {
    const o = addObjective();
    const t = addTask(o);
    db.insert(runs)
      .values({
        id: newId(), taskId: t, objectiveId: o, attempt: 1, sessionId: newId(), model: "m", worktreePath: "/w",
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, costUsdEstimate: 0.5,
      })
      .run();
    db.insert(decisions)
      .values({
        id: newId(), key: "DEC-1", objectiveId: o, taskId: t, level: "L2", title: "?", context: "", options: [],
        recommendation: "a", risk: "low",
      })
      .run();
    const files = (): TaskFiles[] => [
      { taskId: t, attempt: 1, branch: "b", available: true, truncated: false, changes: [{ status: "A", path: "x.ts" }] },
    ];

    await new CloudSync(db, relay, STAMP, { agentFiles: files }).syncOnce();

    const order = relay.order().filter((x) => x !== "events" && x !== "snapshots");
    expect(order).toEqual(["objectives", "tasks", "runs", "decisions", "agent_files"]);
    expect(relay.rows("objectives")[0]).toMatchObject({ ...STAMP, id: o, repo_name: "praktor", cost_usd: 0.5 });
  });

  it("stamps every row with this owner and host", async () => {
    addTask(addObjective());
    appendEvent(db, { payload: { type: "note", message: "hi" } });
    await new CloudSync(db, relay, STAMP, { agentFiles: noFiles }).syncOnce();
    for (const call of relay.calls) {
      for (const row of call.rows) expect(row).toMatchObject(STAMP);
    }
  });

  it("re-sends an objective only when it actually changed", async () => {
    const o = addObjective();
    const sync = new CloudSync(db, relay, STAMP, { agentFiles: noFiles });
    await sync.syncOnce();
    await sync.syncOnce();
    expect(relay.rows("objectives")).toHaveLength(1);

    db.update(objectives).set({ status: "done" }).run();
    await sync.syncOnce();
    expect(relay.rows("objectives").map((r) => r.status)).toEqual(["active", "done"]);
    expect(relay.rows("objectives").every((r) => r.id === o)).toBe(true);
  });

  it("remembers what it sent across restarts", async () => {
    addObjective();
    appendEvent(db, { payload: { type: "note", message: "one" } });
    await new CloudSync(db, relay, STAMP, { agentFiles: noFiles }).syncOnce();

    const after = new FakeRelay();
    await new CloudSync(db, after, STAMP, { agentFiles: noFiles }).syncOnce();
    expect(after.rows("objectives")).toEqual([]);
    expect(after.rows("events")).toEqual([]);
    expect(after.rows("snapshots")).toEqual([]);
  });

  it("resumes after a failure without losing or skipping anything", async () => {
    addObjective();
    appendEvent(db, { payload: { type: "note", message: "one" } });
    const sync = new CloudSync(db, relay, STAMP, { agentFiles: noFiles });

    relay.failOn = "objectives";
    await expect(sync.syncOnce()).rejects.toThrow(/network down/);
    relay.failOn = undefined;
    await sync.syncOnce();

    expect(relay.rows("objectives")).toHaveLength(1);
    expect(relay.rows("events").map((e) => e.text)).toEqual(["one"]);
  });

  it("doesn't advance the event cursor past a batch the relay rejected", async () => {
    appendEvent(db, { payload: { type: "note", message: "one" } });
    const sync = new CloudSync(db, relay, STAMP, { agentFiles: noFiles });
    relay.failOn = "events";
    await expect(sync.syncOnce()).rejects.toThrow();
    relay.failOn = undefined;
    appendEvent(db, { payload: { type: "note", message: "two" } });
    await sync.syncOnce();
    expect(relay.rows("events").map((e) => e.text)).toEqual(["one", "two"]);
  });

  it("keeps local-only events local but still moves past them", async () => {
    appendEvent(db, { payload: { type: "run.message", text: "function secret() {}" } });
    appendEvent(db, { payload: { type: "note", message: "visible" } });
    const sync = new CloudSync(db, relay, STAMP, { agentFiles: noFiles });
    await sync.syncOnce();
    await sync.syncOnce();
    expect(relay.rows("events").map((e) => e.text)).toEqual(["visible"]);
  });

  it("drains a large backlog over several cycles and says so", async () => {
    for (let i = 0; i < 5; i++) addObjective(`o${i}`, i);
    for (let i = 0; i < 25; i++) appendEvent(db, { payload: { type: "note", message: `e${i}` } });
    const sync = new CloudSync(db, relay, STAMP, {
      agentFiles: noFiles, maxObjectivesPerCycle: 2, eventBatchSize: 10, maxEventBatchesPerCycle: 1,
    });

    const first = await sync.syncOnce();
    expect(first).toMatchObject({ objectives: 2, events: 10, backlog: true });
    // Most recently updated objectives go first.
    expect(relay.rows("objectives").map((r) => r.title)).toEqual(["o4", "o3"]);

    let report = first;
    for (let i = 0; i < 5 && report.backlog; i++) report = await sync.syncOnce();
    expect(report.backlog).toBe(false);
    expect(relay.rows("objectives")).toHaveLength(5);
    expect(relay.rows("events")).toHaveLength(25);
  });

  it("keeps the last known files when a task's branch is gone", async () => {
    const o = addObjective();
    const t = addTask(o);
    const gone = (): TaskFiles[] => [{ taskId: t, attempt: 1, branch: "b", available: false, truncated: false, changes: [] }];
    await new CloudSync(db, relay, STAMP, { agentFiles: gone }).syncOnce();
    expect(relay.rows("agent_files")).toEqual([]);
  });

  it("sends snapshots only when they change, and heartbeats on schedule", async () => {
    let now = 1_000_000;
    const sync = new CloudSync(db, relay, STAMP, { agentFiles: noFiles, heartbeatEveryMs: 60_000, now: () => now });
    await sync.syncOnce();
    expect(relay.rows("snapshots").map((s) => s.kind).sort()).toEqual(["costs", "health", "profile"]);
    expect(relay.heartbeats).toBe(1);

    now += 10_000;
    await sync.syncOnce();
    expect(relay.rows("snapshots")).toHaveLength(3);
    expect(relay.heartbeats).toBe(1);

    now += 60_000;
    await sync.syncOnce();
    expect(relay.heartbeats).toBe(2);
  });

  it("starts over for a different host identity, and on reset", async () => {
    addObjective();
    await new CloudSync(db, relay, STAMP, { agentFiles: noFiles }).syncOnce();

    const other = new FakeRelay();
    await new CloudSync(db, other, { owner_id: "owner-1", host_id: "host-2" }, { agentFiles: noFiles }).syncOnce();
    expect(other.rows("objectives")).toHaveLength(1);

    const again = new FakeRelay();
    const sync = new CloudSync(db, again, STAMP, { agentFiles: noFiles });
    sync.reset();
    await sync.syncOnce();
    expect(again.rows("objectives")).toHaveLength(1);
  });
});
