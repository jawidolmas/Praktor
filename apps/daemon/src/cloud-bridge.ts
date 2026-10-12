import {
  CloudSync,
  SupabaseAnswerInbox,
  SupabaseCloudWriter,
  SupabaseMergeInbox,
  createCloudClient,
  getHostStatus,
  loadCloudConfig,
  processAnswers,
  processMerges,
  type CloudConfig,
  type SupabaseClient,
} from "@exec/cloud";
import type { Db } from "@exec/db";

/**
 * The cloud bridge: keeps the Supabase relay's mirror of this machine's
 * state current, so the iOS app can follow it from any network. Like the
 * Telegram bridge, it runs inside the daemon process and only ever makes
 * outbound connections — no port is opened on this machine.
 *
 * It never creates this machine's cloud identity itself: that only happens
 * in `exec-agent cloud connect`, where a person is present to claim it. Until
 * then it idles, re-checking now and then, and a broken network or a revoked
 * host must never take the daemon's real job (driving tasks) down with it.
 */

const SYNC_EVERY_MS = 10_000;
const BACKLOG_EVERY_MS = 1_000;
const IDLE_RECHECK_MS = 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/** Answers and merge requests arrive over Realtime the instant they're
 *  sent; this re-check is only the safety net for a dropped live connection. */
const INBOX_RECHECK_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** A sleep that something else can cut short — here, a Realtime message
 *  saying an answer just arrived. A wake that lands while nobody is asleep
 *  is remembered, so it's never lost between checks. */
class Waker {
  flagged = false;
  private cut: (() => void) | undefined;

  wake(): void {
    this.flagged = true;
    this.cut?.();
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.cut = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.cut = done;
      if (this.flagged) done();
    });
  }
}

/** Logs a message only when it differs from the last one, so a long outage
 *  is one line in the daemon log rather than one per retry. */
function logOnce(): (message: string) => void {
  let last = "";
  return (message) => {
    if (message === last) return;
    last = message;
    console.log(`[cloud] ${message}`);
  };
}

async function readyHost(client: SupabaseClient): Promise<{ ownerId: string; hostId: string } | string> {
  const { data } = await client.auth.getSession();
  if (!data.session) return "not connected — run `exec-agent cloud connect` to pair this PC with the app.";
  const status = await getHostStatus(client, data.session.user.id);
  if (!status.claimed) return "waiting for this PC to be claimed from the app (`exec-agent cloud connect`).";
  if (status.revoked) return "this PC was revoked from the app — run `exec-agent cloud connect` to pair it again.";
  return { ownerId: status.ownerId!, hostId: status.hostId };
}

function sameConfig(a: CloudConfig | undefined, b: CloudConfig | undefined): boolean {
  return a?.url === b?.url && a?.key === b?.key;
}

export async function runCloudBridge(db: Db): Promise<never> {
  const log = logOnce();
  let config: CloudConfig | undefined;
  let client: SupabaseClient | undefined;
  // Kept across re-checks of the host, so repeated failures really do back
  // off instead of restarting from the minimum each time.
  let backoff = SYNC_EVERY_MS;

  for (;;) {
    const latest = loadCloudConfig(db);
    if (!latest) {
      log("disabled — run `exec-agent cloud connect` to sync with the iOS app.");
      await sleep(IDLE_RECHECK_MS);
      continue;
    }
    // Rebuilt only when the project changes; the client owns the session
    // and refreshes its token in the background.
    if (!client || !sameConfig(config, latest)) {
      config = latest;
      client = createCloudClient(config);
    }

    let host: Awaited<ReturnType<typeof readyHost>>;
    try {
      host = await readyHost(client);
    } catch (err) {
      log(`can't reach the relay (${err instanceof Error ? err.message : String(err)}) — will retry.`);
      await sleep(IDLE_RECHECK_MS);
      continue;
    }
    if (typeof host === "string") {
      log(host);
      await sleep(IDLE_RECHECK_MS);
      continue;
    }

    log(`syncing to ${new URL(latest.url).host}.`);
    const sync = new CloudSync(db, new SupabaseCloudWriter(client), { owner_id: host.ownerId, host_id: host.hostId });
    const answers = new SupabaseAnswerInbox(client, host.hostId);
    const merges = new SupabaseMergeInbox(client, host.hostId);
    const waker = new Waker();
    const stopAnswers = answers.watch(() => waker.wake());
    const stopMerges = merges.watch(() => waker.wake());
    let nextSync = 0;
    let nextInboxCheck = 0;

    // Inner loop: apply answers the moment they arrive and sync on a steady
    // beat, until something goes wrong — then fall back out to re-check the
    // host (it may have been revoked, or the project changed).
    try {
      for (;;) {
        try {
          let changed = 0;
          if (waker.flagged || Date.now() >= nextInboxCheck) {
            waker.flagged = false;
            const applied = await processAnswers(db, answers);
            if (applied > 0) console.log(`[cloud] applied ${applied} answer${applied === 1 ? "" : "s"} from the app.`);
            const merged = await processMerges(db, merges);
            if (merged > 0) console.log(`[cloud] merged ${merged} objective${merged === 1 ? "" : "s"} approved from the app.`);
            changed = applied + merged;
            nextInboxCheck = Date.now() + INBOX_RECHECK_MS;
          }
          // An answer or a merge changes local state: send it straight back so
          // the phone sees the result within a second, not on the next beat.
          if (changed > 0 || Date.now() >= nextSync) {
            const report = await sync.syncOnce();
            nextSync = Date.now() + (report.backlog ? BACKLOG_EVERY_MS : SYNC_EVERY_MS);
          }
          if (backoff !== SYNC_EVERY_MS) log("relay reachable again — sync resumed.");
          backoff = SYNC_EVERY_MS;
          await waker.sleep(Math.max(0, Math.min(nextSync, nextInboxCheck) - Date.now()));
          if (!sameConfig(config, loadCloudConfig(db))) break;
        } catch (err) {
          log(`sync failed (${err instanceof Error ? err.message : String(err)}) — retrying with backoff.`);
          await sleep(backoff);
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
          break;
        }
      }
    } finally {
      stopAnswers();
      stopMerges();
    }
  }
}
