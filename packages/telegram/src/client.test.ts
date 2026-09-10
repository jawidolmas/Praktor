import { describe, expect, it, vi } from "vitest";
import { answerCallbackQuery, getUpdates, sendMessage } from "./client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("sendMessage", () => {
  it("posts to the bot's sendMessage endpoint with the chat id and text", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, result: { message_id: 42, date: 0, chat: { id: 1 } } }),
    );
    const result = await sendMessage("TOKEN", "123", "hello", { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/botTOKEN/sendMessage");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ chat_id: "123", text: "hello" });
    expect(result.message_id).toBe(42);
  });

  it("includes an inline keyboard when replyMarkup is given", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, result: { message_id: 1, date: 0, chat: { id: 1 } } }),
    );
    await sendMessage("TOKEN", "123", "hello", {
      fetchImpl,
      replyMarkup: [[{ text: "A", callback_data: "dec:DEC-1:A" }]],
    });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.reply_markup.inline_keyboard).toEqual([[{ text: "A", callback_data: "dec:DEC-1:A" }]]);
  });

  it("throws with Telegram's own description when the API reports an error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ ok: false, description: "chat not found", error_code: 400 }, 400),
    );
    await expect(sendMessage("TOKEN", "bad-chat", "hi", { fetchImpl })).rejects.toThrow(
      /chat not found/,
    );
  });
});

describe("getUpdates", () => {
  it("passes offset and timeout through and returns the result array", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, result: [{ update_id: 7 }] }));
    const updates = await getUpdates("TOKEN", { offset: 8, timeoutSec: 5, fetchImpl });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ offset: 8, timeout: 5 });
    expect(updates).toEqual([{ update_id: 7 }]);
  });

  it("omits offset on the first call", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, result: [] }));
    await getUpdates("TOKEN", { fetchImpl });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty("offset");
  });
});

describe("answerCallbackQuery", () => {
  it("acks the callback with the given id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, result: true }));
    await answerCallbackQuery("TOKEN", "cb-1", "Recorded: B", { fetchImpl });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ callback_query_id: "cb-1", text: "Recorded: B" });
  });
});
