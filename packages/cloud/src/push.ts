import { and, eq, gt, isNull, or } from "drizzle-orm";
import { decisions, getSetting, objectives, setSetting, type Db } from "@exec/db";
import { changedFileCount } from "./agent-files.js";

/**
 * Push notifications to the owner's phone, sent by the computer that knows
 * first: a decision needs them, work is ready to merge, or an objective
 * failed. Delivered through Expo's push service (then Apple's) — the text
 * is a title, never code. Each thing notifies at most once, across daemon
 * restarts, and nothing from before notifications were first enabled on
 * this computer is sent, so turning them on never floods the phone.
 */

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
/** Expo accepts at most 100 messages per request. */
const BATCH = 100;
/** How many already-sent keys to remember; far more than ever pend at once. */
const SENT_MEMORY = 500;

export interface Notice {
  /** Stable identity, so the same thing is never notified twice. */
  key: string;
  title: string;
  body: string;
  /** In-app route the notification opens. */
  url: string;
}

export interface PushOutbox {
  tokens(): Promise<string[]>;
  drop(token: string): Promise<void>;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** What has happened since `since` that the owner should hear about. */
export function collectNotices(db: Db, since: number): Notice[] {
  const notices: Notice[] = [];

  for (const d of db
    .select()
    .from(decisions)
    .where(and(eq(decisions.status, "open"), gt(decisions.createdAt, since)))
    .all()) {
    notices.push({
      key: `decision:${d.id}`,
      title: "Praktor needs a decision",
      body: clip(d.title, 180),
      url: `/decisions/${d.id}`,
    });
  }

  for (const o of db
    .select()
    .from(objectives)
    .where(
      and(
        gt(objectives.updatedAt, since),
        or(and(eq(objectives.status, "done"), isNull(objectives.mergedAt)), eq(objectives.status, "failed")),
      ),
    )
    .all()) {
    const ready = o.status === "done";
    // Finished work that changed nothing has nothing to merge — no ping.
    if (ready && changedFileCount(db, o.id) === 0) continue;
    notices.push({
      key: `${ready ? "ready" : "failed"}:${o.id}`,
      title: ready ? "Ready to merge" : "Objective failed",
      body: clip(o.title, 180),
      url: `/objectives/${o.id}`,
    });
  }
  return notices;
}

/** Sends `notices` to every token. Returns the tokens Expo says are dead
 *  (the app was deleted), so the caller can stop using them. */
export async function sendExpoPush(tokens: string[], notices: Notice[], fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<string[]> {
  const messages = notices.flatMap((n) =>
    tokens.map((to) => ({ to, title: n.title, body: n.body, data: { url: n.url }, sound: "default", priority: "high" })),
  );
  const dead = new Set<string>();
  for (let i = 0; i < messages.length; i += BATCH) {
    const batch = messages.slice(i, i + BATCH);
    const res = await fetchImpl(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(batch),
    });
    if (!res.ok) throw new Error(`Expo push service answered ${res.status}`);
    const body = (await res.json()) as { data?: { status?: string; details?: { error?: string } }[] };
    (body.data ?? []).forEach((ticket, j) => {
      if (ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered") dead.add(batch[j]!.to);
    });
  }
  return [...dead];
}

/**
 * One notification pass. State lives in local settings, scoped per host:
 * a start time (set on the first pass, so history is never sent) and the
 * keys already sent. A key is recorded only after Expo accepted it, so a
 * failed send is retried on the next pass rather than lost.
 */
export async function processPush(
  db: Db,
  outbox: PushOutbox,
  hostId: string,
  options: { now?: number; fetchImpl?: FetchLike } = {},
): Promise<number> {
  const now = options.now ?? Date.now();
  const sinceKey = `push:${hostId}:since`;
  const sentKey = `push:${hostId}:sent`;

  const sinceRaw = getSetting(db, sinceKey);
  if (sinceRaw === undefined) {
    setSetting(db, sinceKey, String(now));
    return 0;
  }
  let sent: string[] = [];
  try {
    sent = JSON.parse(getSetting(db, sentKey) ?? "[]") as string[];
  } catch {
    sent = [];
  }
  const seen = new Set(sent);
  const fresh = collectNotices(db, Number(sinceRaw)).filter((n) => !seen.has(n.key));
  if (fresh.length === 0) return 0;

  const tokens = await outbox.tokens();
  if (tokens.length > 0) {
    const dead = await sendExpoPush(tokens, fresh, options.fetchImpl);
    for (const token of dead) await outbox.drop(token);
  }
  // Recorded even with no phone registered: turning notifications on later
  // shouldn't replay everything that happened meanwhile.
  setSetting(db, sentKey, JSON.stringify([...sent, ...fresh.map((n) => n.key)].slice(-SENT_MEMORY)));
  return tokens.length > 0 ? fresh.length : 0;
}
