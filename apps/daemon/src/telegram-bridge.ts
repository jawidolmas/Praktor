import {
  answerDecision,
  approximateHealthSince,
  getSetting,
  markDecisionNotified,
  objectives,
  openDecisions,
  readyToMergeObjectives,
  recoveredTasksSince,
  setSetting,
  unnotifiedDecisions,
  type Db,
} from "@exec/db";
import {
  answerCallbackQuery,
  decisionKeyboard,
  editMessageText,
  formatAnsweredSuffix,
  formatDecisionMessage,
  formatDigestMessage,
  getUpdates,
  parseDecisionCallback,
  sendMessage,
  type DecisionNotice,
  type DigestSnapshot,
  type TelegramUpdate,
} from "@exec/telegram";

/**
 * The Telegram bridge: the "walk away and still be reachable" half of
 * escalation. `request_decision` already lets a worker block on a real
 * question instead of guessing — this is what makes answering one not
 * require sitting at a terminal or the dashboard. It runs inside the daemon
 * process rather than as a separate one: it's two independent async loops
 * (push newly-raised decisions, long-poll for replies) that interleave with
 * `mainLoop` for free on Node's event loop, so it gets the daemon's existing
 * single-instance lock and Windows-safe lifecycle without re-solving either.
 *
 * Both loops are individually caught-and-retried forever — a bad token, a
 * network blip, or a malformed update must never take the daemon's actual
 * job (driving tasks) down with it.
 */

const NOTIFY_POLL_MS = 5000;
const TELEGRAM_OFFSET_KEY = "telegram_update_offset";
const DIGEST_CHECK_MS = 60_000;
const DIGEST_LAST_SENT_KEY = "telegram_last_digest_at";

/** Local hour (0-23) the daily digest fires at. Defaults to 8am — "the very
 *  first thing in the morning" is a person's local morning, not UTC. */
export function digestHour(): number {
  const raw = process.env["TELEGRAM_DIGEST_HOUR"];
  const parsed = raw !== undefined ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 23 ? parsed : 8;
}

export interface TelegramBridgeConfig {
  token: string;
  chatId: string;
}

export function loadTelegramConfig(): TelegramBridgeConfig | undefined {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const chatId = process.env["TELEGRAM_CHAT_ID"];
  if (!token || !chatId) return undefined;
  return { token, chatId };
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function toNotice(row: {
  key: string;
  title: string;
  context: string;
  options: DecisionNotice["options"];
  recommendation: string;
  risk: string;
}): DecisionNotice {
  return {
    key: row.key,
    title: row.title,
    context: row.context,
    options: row.options,
    recommendation: row.recommendation,
    risk: row.risk as DecisionNotice["risk"],
  };
}

/** Pushes a notification for every open decision nobody has been told about
 *  yet. Runs on its own short interval rather than only between long-poll
 *  cycles, so a freshly-raised decision doesn't wait on Telegram's poll
 *  timeout before you hear about it. */
async function notifyLoop(db: Db, config: TelegramBridgeConfig): Promise<never> {
  for (;;) {
    try {
      for (const row of unnotifiedDecisions(db)) {
        const notice = toNotice(row);
        const sent = await sendMessage(config.token, config.chatId, formatDecisionMessage(notice), {
          replyMarkup: decisionKeyboard(notice),
        });
        markDecisionNotified(db, row.id, sent.message_id);
      }
    } catch (err) {
      console.error("[telegram] notify loop failed, will retry:", err);
    }
    await sleep(NOTIFY_POLL_MS);
  }
}

async function handleUpdate(db: Db, config: TelegramBridgeConfig, update: TelegramUpdate): Promise<void> {
  const cq = update.callback_query;
  if (!cq?.data) return;

  const parsed = parseDecisionCallback(cq.data);
  if (!parsed) return;

  const answeredBy = cq.from.username ? `telegram:${cq.from.username}` : `telegram:${cq.from.id}`;
  const applied = answerDecision(db, { key: parsed.key, answer: parsed.optionId, answeredBy });

  await answerCallbackQuery(
    config.token,
    cq.id,
    applied ? `Recorded: ${parsed.optionId}` : "Already answered, or not an open decision.",
  ).catch((err: unknown) => console.error("[telegram] answerCallbackQuery failed:", err));

  if (applied && cq.message?.text) {
    await editMessageText(
      config.token,
      config.chatId,
      cq.message.message_id,
      cq.message.text + formatAnsweredSuffix(parsed.optionId, answeredBy),
    ).catch((err: unknown) => console.error("[telegram] editMessageText failed:", err));
  }
}

/** Long-polls for replies (button taps today) and answers the matching
 *  decision the same way `exec-agent decide` or the dashboard would — same
 *  `answerDecision` write, so nothing downstream needs to know which
 *  channel a decision came back through. */
async function pollLoop(db: Db, config: TelegramBridgeConfig): Promise<never> {
  let offset = Number(getSetting(db, TELEGRAM_OFFSET_KEY) ?? "0") || undefined;
  for (;;) {
    try {
      const updates = await getUpdates(config.token, {
        ...(offset !== undefined ? { offset } : {}),
        timeoutSec: 25,
      });
      for (const update of updates) {
        await handleUpdate(db, config, update);
        offset = update.update_id + 1;
      }
      if (updates.length > 0) setSetting(db, TELEGRAM_OFFSET_KEY, String(offset));
    } catch (err) {
      console.error("[telegram] poll loop failed, will retry:", err);
      await sleep(NOTIFY_POLL_MS);
    }
  }
}

export function buildDigestSnapshot(db: Db, since: number): DigestSnapshot {
  const all = db.select().from(objectives).all();
  const byStatus = (status: string): string[] =>
    all.filter((o) => o.status === status).map((o) => o.title);

  const decisionsNeeded = openDecisions(db).map((d) => {
    const recommended = d.options.find((o) => o.id === d.recommendation);
    return { key: d.key, title: d.title, recommendationLabel: recommended?.label ?? d.recommendation };
  });

  return {
    finishedSinceLast: all
      .filter((o) => (o.status === "done" || o.status === "failed") && o.updatedAt > since)
      .map((o) => `${o.title} (${o.status})`),
    active: byStatus("active"),
    blocked: byStatus("blocked"),
    parked: byStatus("parked"),
    recovered: recoveredTasksSince(db, since).map((r) => ({
      taskTitle: r.taskTitle,
      cause: r.cause,
      class: r.class,
    })),
    decisionsNeeded,
    readyToMerge: readyToMergeObjectives(db).map((o) => o.title),
    health: approximateHealthSince(db, since),
  };
}

/** Fires once per local calendar day at `digestHour()`, regardless of
 *  whether there's anything to report — the point (per the brief this was
 *  built from) is a standing morning check-in, not only escalating when
 *  something needs a decision. The last-sent timestamp survives a daemon
 *  restart via `settings`, so a restart right at the boundary can't double-send. */
async function digestLoop(db: Db, config: TelegramBridgeConfig): Promise<never> {
  const hour = digestHour();
  for (;;) {
    try {
      const now = new Date();
      const lastSentRaw = getSetting(db, DIGEST_LAST_SENT_KEY);
      const lastSentAt = lastSentRaw !== undefined ? Number(lastSentRaw) : 0;
      const sentToday = lastSentAt > 0 && new Date(lastSentAt).toDateString() === now.toDateString();

      if (now.getHours() >= hour && !sentToday) {
        const snapshot = buildDigestSnapshot(db, lastSentAt);
        await sendMessage(config.token, config.chatId, formatDigestMessage(snapshot));
        setSetting(db, DIGEST_LAST_SENT_KEY, String(Date.now()));
      }
    } catch (err) {
      console.error("[telegram] digest loop failed, will retry:", err);
    }
    await sleep(DIGEST_CHECK_MS);
  }
}

export async function runTelegramBridge(db: Db, config: TelegramBridgeConfig): Promise<never> {
  console.log(`[telegram] bridge active — pushing to chat ${config.chatId}`);
  await Promise.all([notifyLoop(db, config), pollLoop(db, config), digestLoop(db, config)]);
  throw new Error("unreachable: telegram bridge loops never return");
}
