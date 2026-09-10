import { readFileSync } from "node:fs";
import { basename } from "node:path";

/**
 * A thin, direct wrapper over the Telegram Bot HTTP API — no SDK, because the
 * surface we need (send a message, send a document, long-poll for replies)
 * is four endpoints. `fetchImpl` is injectable purely so tests can stub the
 * network without a real bot token.
 *
 * Long polling (`getUpdates`) rather than a webhook is deliberate: it needs
 * no public URL, no reverse proxy, nothing exposed — the daemon just asks
 * Telegram "anything new?" and Telegram holds the connection open until
 * there is. That fits a supervisor that already runs as one persistent
 * local process.
 */

const API_ROOT = "https://api.telegram.org";

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface RequestOpts {
  fetchImpl?: typeof fetch;
}

async function call<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  opts: RequestOpts = {},
): Promise<T> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${API_ROOT}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as TelegramApiResponse<T>;
  if (!json.ok) {
    throw new Error(
      `Telegram ${method} failed: ${json.description ?? res.statusText} (${json.error_code ?? res.status})`,
    );
  }
  return json.result as T;
}

export async function sendMessage(
  token: string,
  chatId: string,
  text: string,
  opts: RequestOpts & { replyMarkup?: InlineButton[][] } = {},
): Promise<TelegramMessage> {
  return call<TelegramMessage>(
    token,
    "sendMessage",
    {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      ...(opts.replyMarkup ? { reply_markup: { inline_keyboard: opts.replyMarkup } } : {}),
    },
    opts,
  );
}

export async function editMessageText(
  token: string,
  chatId: string,
  messageId: number,
  text: string,
  opts: RequestOpts = {},
): Promise<void> {
  await call<TelegramMessage>(
    token,
    "editMessageText",
    { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" },
    opts,
  );
}

export async function answerCallbackQuery(
  token: string,
  callbackQueryId: string,
  text: string | undefined,
  opts: RequestOpts = {},
): Promise<void> {
  await call<true>(
    token,
    "answerCallbackQuery",
    { callback_query_id: callbackQueryId, ...(text ? { text } : {}) },
    opts,
  );
}

/** Sends a local file as a document (used for the end-of-run PDF packet).
 *  Telegram bots may send documents up to 50MB. */
export async function sendDocument(
  token: string,
  chatId: string,
  filePath: string,
  opts: RequestOpts & { caption?: string } = {},
): Promise<TelegramMessage> {
  const doFetch = opts.fetchImpl ?? fetch;
  const form = new FormData();
  form.set("chat_id", chatId);
  if (opts.caption) form.set("caption", opts.caption);
  form.set("document", new Blob([readFileSync(filePath)]), basename(filePath));

  const res = await doFetch(`${API_ROOT}/bot${token}/sendDocument`, {
    method: "POST",
    body: form,
  });
  const json = (await res.json()) as TelegramApiResponse<TelegramMessage>;
  if (!json.ok) {
    throw new Error(
      `Telegram sendDocument failed: ${json.description ?? res.statusText} (${json.error_code ?? res.status})`,
    );
  }
  return json.result as TelegramMessage;
}

/**
 * One long-poll cycle: blocks server-side for up to `timeoutSec` and returns
 * as soon as there is at least one update, or an empty array on timeout.
 * `offset` must be the last-seen `update_id + 1` — Telegram treats a
 * `getUpdates` call with a given offset as acknowledging every earlier
 * update, so losing this value (e.g. not persisting it across a restart)
 * either replays old updates or skips ones that arrived while offline.
 */
export async function getUpdates(
  token: string,
  opts: RequestOpts & { offset?: number; timeoutSec?: number } = {},
): Promise<TelegramUpdate[]> {
  return call<TelegramUpdate[]>(
    token,
    "getUpdates",
    {
      ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
      timeout: opts.timeoutSec ?? 25,
      allowed_updates: ["message", "callback_query"],
    },
    opts,
  );
}
