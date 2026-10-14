import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { eq } from "drizzle-orm";
import { getSetting, objectives, RUN_DEFAULTS, setSetting, submitDraftObjective, submitObjective, type Db } from "@exec/db";
import { findGitRepos, inferCheck, triage, type Triage } from "@exec/worker";
import { scrubPaths } from "./merge.js";

/**
 * "Say what you want" from the phone. Each computer offers its repos by
 * folder name, keyed by an opaque hash of the real path (the path itself
 * never leaves the machine); a request names one of those keys, and the
 * computer turns the message into an objective through exactly the intake
 * `exec-agent do` uses: a specific check for an obviously single-step
 * request, the planner for anything else, the same defaults either way.
 */

export interface LocalRepo {
  key: string;
  name: string;
  path: string;
  lastUsedAt: number | null;
}

/** Stable and opaque: the same folder always gets the same key, and the key
 *  reveals nothing about where the folder is. */
export function repoKey(path: string): string {
  const normalized = (process.platform === "win32" ? path.toLowerCase() : path).replace(/\\/g, "/").replace(/\/+$/, "");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/** Every repo this computer can work in: the ones found where `do` looks,
 *  plus any an objective has already run in (if it still exists). */
export function localRepos(db: Db, discover: () => { name: string; path: string }[] = findGitRepos): Map<string, LocalRepo> {
  const repos = new Map<string, LocalRepo>();
  const add = (path: string, name: string, usedAt: number | null) => {
    const key = repoKey(path);
    const seen = repos.get(key);
    if (seen) {
      if (usedAt !== null && (seen.lastUsedAt === null || usedAt > seen.lastUsedAt)) seen.lastUsedAt = usedAt;
    } else {
      repos.set(key, { key, name, path, lastUsedAt: usedAt });
    }
  };
  for (const r of discover()) add(r.path, r.name, null);
  for (const o of db.select({ repoPath: objectives.repoPath, createdAt: objectives.createdAt }).from(objectives).all()) {
    if (existsSync(o.repoPath)) add(o.repoPath, basename(o.repoPath), o.createdAt);
  }
  return repos;
}

export interface PendingRequest {
  id: string;
  thread_id: string;
  repo_key: string;
  message: string;
  created_at: string;
}

export interface EarlierRequest {
  message: string;
  objective_id: string | null;
}

export interface RequestInbox {
  pending(): Promise<PendingRequest[]>;
  /** The conversation so far, oldest first, before this request. */
  earlier(threadId: string, before: string): Promise<EarlierRequest[]>;
  settle(
    id: string,
    status: "started" | "rejected" | "replied",
    objectiveId: string | null,
    reason: string | null,
    reply?: string,
  ): Promise<void>;
}

const STATUS_WORDS: Record<string, string> = {
  draft: "being planned",
  active: "in progress",
  parked: "paused",
  blocked: "waiting on a decision",
  done: "finished",
  failed: "failed",
  cancelled: "cancelled",
};

/** What the agent should know about the conversation so far, so a
 *  follow-up like "now add tests for it" knows what "it" is. */
export function conversationContext(db: Db, earlier: EarlierRequest[]): string | undefined {
  if (earlier.length === 0) return undefined;
  const lines = earlier.slice(-5).map((e, i) => {
    const o = e.objective_id ? db.select().from(objectives).where(eq(objectives.id, e.objective_id)).get() : undefined;
    const outcome = o ? ` (${o.mergedAt ? "finished and merged" : (STATUS_WORDS[o.status] ?? o.status)})` : "";
    return `${i + 1}. "${e.message.slice(0, 600)}"${outcome}`;
  });
  return (
    "This continues an earlier conversation with the same person. What they asked before, oldest first:\n" +
    lines.join("\n")
  );
}

/** Starts an objective from a phone message — the `do` intake. */
export function startFromRequest(db: Db, args: { repoPath: string; message: string; context?: string }): string {
  const message = args.message.trim();
  const firstLine = message.split(/\r?\n/)[0] ?? message;
  const common = {
    ...RUN_DEFAULTS,
    repoPath: args.repoPath,
    title: firstLine.slice(0, 72),
    intent: args.context ? `${message}\n\n${args.context}` : message,
  };
  // Inferred from the message itself, not the context: a follow-up's history
  // must not turn "now add tests" into a check for some earlier file.
  const inferred = inferCheck(message, args.repoPath);
  return inferred.specific
    ? submitObjective(db, { ...common, checks: [inferred.check] }).objectiveId
    : submitDraftObjective(db, common).objectiveId;
}

/** Decides whether a message is work at all. */
export type Classify = (message: string, repo: LocalRepo, earlier: EarlierRequest[]) => Promise<Triage>;

/** Wraps a triage function so that if it fails for any reason, the
 *  message is treated as work: a genuine request must never be dropped
 *  because the check broke. */
export function makeClassify(check: typeof triage = triage): Classify {
  return (message, repo, earlier) =>
    check({ message, repoName: repo.name, earlier: earlier.map((e) => e.message), cwd: repo.path }).catch(
      (): Triage => ({ kind: "task" }),
    );
}

export const defaultClassify: Classify = makeClassify();

/** Handles every pending request; returns how many objectives it started. */
export async function processRequests(
  db: Db,
  inbox: RequestInbox,
  repos: () => Map<string, LocalRepo> = () => localRepos(db),
  classify: Classify = defaultClassify,
): Promise<number> {
  const pending = await inbox.pending();
  if (pending.length === 0) return 0;
  const known = repos();
  let started = 0;
  for (const r of pending) {
    // Started before, but the report back was lost (a dropped connection
    // between starting and settling): report the same objective again rather
    // than starting the work a second time.
    const startedBefore = getSetting(db, `request:${r.id}`);
    if (startedBefore) {
      await inbox.settle(r.id, "started", startedBefore, null);
      continue;
    }
    const repo = known.get(r.repo_key);
    if (!repo || !existsSync(repo.path)) {
      await inbox.settle(r.id, "rejected", null, "That repo isn’t on this computer anymore — it may have been moved or deleted.");
      continue;
    }
    // Network trouble (reading the conversation, reporting back) propagates
    // to the caller's retry: it must never be mistaken for the request
    // itself failing, or a request that did start would read as "rejected".
    const earlier = await inbox.earlier(r.thread_id, r.created_at);
    // "Thanks" gets a reply, not an 8-cent run with a Merge button for nothing.
    const kind = await classify(r.message, repo, earlier);
    if (kind.kind !== "task") {
      await inbox.settle(r.id, "replied", null, null, kind.reply ?? "");
      continue;
    }
    const context = conversationContext(db, earlier);
    let objectiveId: string;
    try {
      objectiveId = startFromRequest(db, { repoPath: repo.path, message: r.message, ...(context ? { context } : {}) });
    } catch (err) {
      const reason = scrubPaths(`Couldn’t start it: ${err instanceof Error ? err.message : String(err)}`, repo.path);
      await inbox.settle(r.id, "rejected", null, reason.slice(0, 500));
      continue;
    }
    setSetting(db, `request:${r.id}`, objectiveId);
    await inbox.settle(r.id, "started", objectiveId, null);
    started += 1;
  }
  return started;
}
