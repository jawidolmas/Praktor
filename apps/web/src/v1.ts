import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { authenticateDevice, createDevice, type Db, type DeviceInfo } from "@exec/db";
import {
  getAgentTree,
  getApprovalStatus,
  getCostRollup,
  getDaemonStatus,
  getGraphStats,
  getHealthSnapshot,
  getObjective,
  getObjectiveEvents,
  getReports,
  listActivity,
  listDecisionHistory,
  listObjectives,
  listOpenDecisions,
  listPolicies,
  listProfile,
} from "./api.js";
import { bearerToken, type PairingCodes, type RateLimiter, sanitizeDeviceName } from "./security.js";

/**
 * `/api/v1` — the companion app's API. Versioned so the iOS app can ship on
 * its own release cycle: anything that changes a response's shape goes into
 * a `/api/v2`, never silently into this one.
 *
 * Read-only for now, apart from the pairing exchange itself. Every route
 * but `POST /pair` requires a device token, regardless of where the request
 * came from — including loopback, since a local reverse proxy is exactly
 * how a phone is expected to reach this.
 */

export const API_VERSION = 1;

const SERVER_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

/** IDs in this system are UUIDs; anything else in a path segment is
 *  rejected before it reaches a query. */
const ID = "([A-Za-z0-9_-]{1,64})";

export interface V1Context {
  db: Db;
  pairing: PairingCodes;
  pairLimiter: RateLimiter;
  readJsonBody: (req: IncomingMessage) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  streamObjectiveEvents: (req: IncomingMessage, res: ServerResponse, objectiveId: string, resumeAfter?: number) => void;
}

function clampInt(raw: string | null, fallback: number, max: number): number {
  const n = Number(raw ?? fallback);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

export async function handleV1(ctx: V1Context, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const { db, sendJson } = ctx;
  const path = url.pathname.slice("/api/v1".length) || "/";
  const method = req.method ?? "GET";

  try {
    if (path === "/pair") {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      return await pair(ctx, req, res);
    }

    const token = bearerToken(req);
    const device: DeviceInfo | undefined = token ? authenticateDevice(db, token) : undefined;
    if (!device) {
      res.setHeader("www-authenticate", 'Bearer realm="praktor"');
      return sendJson(res, 401, { error: "unauthorized" });
    }

    if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });

    if (path === "/me") {
      return sendJson(res, 200, { apiVersion: API_VERSION, serverVersion: SERVER_VERSION, device });
    }
    if (path === "/daemon") return sendJson(res, 200, getDaemonStatus());
    if (path === "/objectives") return sendJson(res, 200, listObjectives(db));
    if (path === "/decisions") return sendJson(res, 200, listOpenDecisions(db));
    if (path === "/decisions/history") {
      return sendJson(res, 200, listDecisionHistory(db, clampInt(url.searchParams.get("limit"), 300, 1000)));
    }
    if (path === "/policies") return sendJson(res, 200, listPolicies(db));
    if (path === "/profile") return sendJson(res, 200, listProfile(db));
    if (path === "/costs") return sendJson(res, 200, getCostRollup(db));
    if (path === "/health") {
      const days = clampInt(url.searchParams.get("days"), 7, 90);
      return sendJson(res, 200, getHealthSnapshot(db, days * 24 * 60 * 60 * 1000));
    }
    if (path === "/activity") {
      return sendJson(res, 200, listActivity(db, clampInt(url.searchParams.get("limit"), 80, 500)));
    }

    const sub = new RegExp(`^/objectives/${ID}(?:/(events|stream|reports|graph|approval|tree))?$`).exec(path);
    if (sub?.[1]) {
      const id = sub[1];
      switch (sub[2]) {
        case undefined: {
          const detail = getObjective(db, id);
          return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: "not found" });
        }
        case "events": {
          const after = url.searchParams.get("afterId");
          const afterId = after !== null && /^\d{1,15}$/.test(after) ? Number(after) : undefined;
          return sendJson(res, 200, getObjectiveEvents(db, id, afterId));
        }
        case "stream": {
          // EventSource clients send Last-Event-ID on reconnect; resume from
          // there instead of replaying the whole backlog.
          const last = req.headers["last-event-id"];
          const resumeAfter = typeof last === "string" && /^\d{1,15}$/.test(last) ? Number(last) : undefined;
          ctx.streamObjectiveEvents(req, res, id, resumeAfter);
          return;
        }
        case "reports":
          return sendJson(res, 200, getReports(db, id));
        case "graph": {
          const stats = getGraphStats(db, id);
          return stats ? sendJson(res, 200, stats) : sendJson(res, 404, { error: "not found" });
        }
        case "approval":
          return sendJson(res, 200, getApprovalStatus(db, id));
        case "tree": {
          const tree = getAgentTree(db, id);
          return tree ? sendJson(res, 200, tree) : sendJson(res, 404, { error: "not found" });
        }
      }
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (err) {
    // Unlike the local dashboard, never echo internals (paths, SQL, git
    // output) to a remote caller — log them here instead.
    console.error("[api/v1]", err);
    if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
  }
}

/** Exchanges a live pairing code (from the dashboard's QR) for a device
 *  token. The code is single-use: whichever device redeems it first wins,
 *  and the dashboard shows that device by name right away. */
async function pair(ctx: V1Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { sendJson } = ctx;
  if (!ctx.pairLimiter.allow(req.socket.remoteAddress ?? "unknown")) {
    return sendJson(res, 429, { error: "too many attempts — wait a minute and try again" });
  }

  let body: { code?: unknown; deviceName?: unknown };
  try {
    body = (await ctx.readJsonBody(req)) as typeof body;
  } catch {
    return sendJson(res, 400, { error: "invalid request body" });
  }

  const name = sanitizeDeviceName(body.deviceName);
  if (typeof body.code !== "string" || body.code.length > 128 || !name) {
    return sendJson(res, 400, { error: "code and deviceName are required" });
  }
  if (!ctx.pairing.consume(body.code)) {
    return sendJson(res, 401, { error: "this pairing code is invalid or has expired — show a new one on the dashboard" });
  }

  const { device, token } = createDevice(ctx.db, name);
  res.setHeader("cache-control", "no-store");
  return sendJson(res, 201, { apiVersion: API_VERSION, serverVersion: SERVER_VERSION, device, token });
}
