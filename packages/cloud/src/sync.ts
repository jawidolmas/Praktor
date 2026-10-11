import { createHash } from "node:crypto";
import { asc, desc, eq, gt } from "drizzle-orm";
import {
  approximateHealthSince,
  decisions,
  events,
  getCostRollup,
  getSetting,
  listMemories,
  objectives,
  recoveredTasksSince,
  runs,
  setSetting,
  tasks,
  type Db,
} from "@exec/db";
import { agentFilesFor, type TaskFiles } from "./agent-files.js";
import {
  toCloudAgentFiles,
  toCloudDecision,
  toCloudEvent,
  toCloudObjective,
  toCloudRun,
  toCloudTask,
  type Stamp,
} from "./mapping.js";

/**
 * Pushes local state up to the relay. One direction only — this machine is
 * the source of truth and the relay is a mirror the phone reads.
 *
 * Built to be interrupted at any point (a crash, a reboot, three days with
 * no network) and pick up exactly where it stopped:
 *   - objectives are re-sent only when their content fingerprint changes,
 *     and each fingerprint is persisted only after that objective's rows
 *     were all accepted;
 *   - events advance a persisted cursor only after a batch is accepted;
 *   - every write is an idempotent upsert, so re-sending is always safe.
 */

export type CloudTable = "objectives" | "tasks" | "runs" | "decisions" | "agent_files" | "events" | "snapshots";

/** The relay as the sync engine sees it — implemented over supabase-js in
 *  production, and by an in-memory fake in tests. */
export interface CloudWriter {
  upsert(table: CloudTable, rows: object[], onConflict: string): Promise<void>;
  heartbeat(): Promise<void>;
}

export interface SyncOptions {
  /** Reads changed paths from git. Injectable so tests don't need a repo. */
  agentFiles?: (db: Db, objectiveId: string) => TaskFiles[];
  /** Changed objectives handled per cycle. Each may run git, which blocks
   *  the daemon's event loop, so a large backlog drains over several
   *  cycles instead of in one long stall. */
  maxObjectivesPerCycle?: number;
  eventBatchSize?: number;
  maxEventBatchesPerCycle?: number;
  heartbeatEveryMs?: number;
  now?: () => number;
}

export interface SyncReport {
  objectives: number;
  events: number;
  snapshots: number;
  /** True when a cap was hit and there's more to send right away. */
  backlog: boolean;
}

const CHUNK = 500;
const HEALTH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function chunks<T>(rows: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export class CloudSync {
  private readonly stamp: Stamp;
  private readonly agentFiles: (db: Db, objectiveId: string) => TaskFiles[];
  private readonly maxObjectives: number;
  private readonly eventBatchSize: number;
  private readonly maxEventBatches: number;
  private readonly heartbeatEveryMs: number;
  private readonly now: () => number;
  private lastHeartbeat = 0;

  constructor(
    private readonly db: Db,
    private readonly writer: CloudWriter,
    stamp: Stamp,
    options: SyncOptions = {},
  ) {
    this.stamp = { owner_id: stamp.owner_id, host_id: stamp.host_id };
    this.agentFiles = options.agentFiles ?? agentFilesFor;
    this.maxObjectives = options.maxObjectivesPerCycle ?? 10;
    this.eventBatchSize = options.eventBatchSize ?? CHUNK;
    this.maxEventBatches = options.maxEventBatchesPerCycle ?? 5;
    this.heartbeatEveryMs = options.heartbeatEveryMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  /** Sync state is scoped to the host identity: re-claiming this PC as a
   *  new host (or under a new owner) starts a fresh full upload. */
  private key(name: string): string {
    return `cloud_sync:${this.stamp.host_id}:${name}`;
  }

  private readJson<T>(name: string, fallback: T): T {
    const raw = getSetting(this.db, this.key(name));
    if (raw === undefined) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private writeJson(name: string, value: unknown): void {
    setSetting(this.db, this.key(name), JSON.stringify(value));
  }

  async syncOnce(): Promise<SyncReport> {
    const objectivesReport = await this.syncObjectives();
    const eventsReport = await this.syncEvents();
    const snapshots = await this.syncSnapshots();
    if (this.now() - this.lastHeartbeat >= this.heartbeatEveryMs) {
      await this.writer.heartbeat();
      this.lastHeartbeat = this.now();
    }
    return {
      objectives: objectivesReport.sent,
      events: eventsReport.sent,
      snapshots,
      backlog: objectivesReport.backlog || eventsReport.backlog,
    };
  }

  private async syncObjectives(): Promise<{ sent: number; backlog: boolean }> {
    const fingerprints = this.readJson<Record<string, string>>("fingerprints", {});
    let sent = 0;

    for (const o of this.db.select().from(objectives).orderBy(desc(objectives.updatedAt)).all()) {
      const taskRows = this.db.select().from(tasks).where(eq(tasks.objectiveId, o.id)).orderBy(asc(tasks.key)).all();
      const runRows = this.db.select().from(runs).where(eq(runs.objectiveId, o.id)).orderBy(asc(runs.startedAt)).all();
      const decisionRows = this.db
        .select()
        .from(decisions)
        .where(eq(decisions.objectiveId, o.id))
        .orderBy(asc(decisions.createdAt))
        .all();

      const costUsd = runRows.reduce((sum, r) => sum + r.costUsdEstimate, 0);
      const objectiveRow = toCloudObjective(o, costUsd, this.stamp);
      const taskCloud = taskRows.map((t) => toCloudTask(t, this.stamp));
      const runCloud = runRows.map((r) => toCloudRun(r, this.stamp));
      const decisionCloud = decisionRows.map((d) => toCloudDecision(d, this.stamp));

      const fingerprint = sha256([objectiveRow, taskCloud, runCloud, decisionCloud]);
      if (fingerprints[o.id] === fingerprint) continue;
      if (sent >= this.maxObjectives) return { sent, backlog: true };

      // Parents before children: the relay's foreign keys require it.
      await this.writer.upsert("objectives", [objectiveRow], "owner_id,id");
      for (const batch of chunks(taskCloud)) await this.writer.upsert("tasks", batch, "owner_id,id");
      for (const batch of chunks(runCloud)) await this.writer.upsert("runs", batch, "owner_id,id");
      for (const batch of chunks(decisionCloud)) await this.writer.upsert("decisions", batch, "owner_id,id");

      // A branch that's gone (merged, cleaned up) leaves what was last
      // recorded in place rather than erasing the history of what it did.
      for (const files of this.agentFiles(this.db, o.id)) {
        if (!files.available) continue;
        for (const batch of chunks(toCloudAgentFiles(o.id, files, this.stamp))) {
          await this.writer.upsert("agent_files", batch, "owner_id,task_id,path");
        }
      }

      fingerprints[o.id] = fingerprint;
      this.writeJson("fingerprints", fingerprints);
      sent += 1;
    }
    return { sent, backlog: false };
  }

  private async syncEvents(): Promise<{ sent: number; backlog: boolean }> {
    let cursor = Number(getSetting(this.db, this.key("event_cursor")) ?? "0") || 0;
    let sent = 0;

    for (let batchNo = 0; batchNo < this.maxEventBatches; batchNo++) {
      const rows = this.db
        .select()
        .from(events)
        .where(gt(events.id, cursor))
        .orderBy(asc(events.id))
        .limit(this.eventBatchSize)
        .all();
      if (rows.length === 0) return { sent, backlog: false };

      const cloud = rows.flatMap((e) => toCloudEvent(e, this.stamp) ?? []);
      if (cloud.length > 0) await this.writer.upsert("events", cloud, "owner_id,host_id,id");

      // Advance past filtered-out events too, or they'd be re-read forever.
      cursor = rows[rows.length - 1]!.id;
      setSetting(this.db, this.key("event_cursor"), String(cursor));
      sent += cloud.length;
      if (rows.length < this.eventBatchSize) return { sent, backlog: false };
    }
    return { sent, backlog: true };
  }

  private async syncSnapshots(): Promise<number> {
    const hashes = this.readJson<Record<string, string>>("snapshot_hashes", {});
    const since = this.now() - HEALTH_WINDOW_MS;
    const snapshots: Record<string, unknown> = {
      health: {
        health: approximateHealthSince(this.db, since),
        recovered: recoveredTasksSince(this.db, since),
        windowMs: HEALTH_WINDOW_MS,
      },
      costs: getCostRollup(this.db),
      // The engineering profile is the "permanent" memory tier, same as the dashboard.
      profile: listMemories(this.db, "permanent").map((m) => ({ title: m.title, content: m.content })),
    };

    let sent = 0;
    for (const [kind, data] of Object.entries(snapshots)) {
      const hash = sha256(data);
      if (hashes[kind] === hash) continue;
      await this.writer.upsert("snapshots", [{ ...this.stamp, kind, data, updated_at: this.now() }], "owner_id,host_id,kind");
      hashes[kind] = hash;
      this.writeJson("snapshot_hashes", hashes);
      sent += 1;
    }
    return sent;
  }

  /** Forgets what was sent, so the next cycle re-uploads everything — for
   *  when the relay was wiped or a sync is suspected to have drifted. */
  reset(): void {
    for (const name of ["fingerprints", "event_cursor", "snapshot_hashes"]) {
      setSetting(this.db, this.key(name), name === "event_cursor" ? "0" : "{}");
    }
  }
}
