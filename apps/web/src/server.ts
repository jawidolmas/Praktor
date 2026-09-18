import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "@exec/db";
import {
  answerOpenDecision,
  approveObjective,
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

const PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "public");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

/** Reads and parses a JSON request body, capped well above anything a
 *  decision answer could plausibly need — this is the only endpoint that
 *  accepts one, so there's no reason to pull in a body-parser dependency
 *  for it. */
function readJsonBody(req: IncomingMessage, maxBytes = 16 * 1024): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        rejectPromise(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(text));
      } catch {
        rejectPromise(new Error("invalid JSON body"));
      }
    });
    req.on("error", rejectPromise);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function serveStatic(res: ServerResponse, requestPath: string): boolean {
  // Request paths off an HTTP URL are always posix-style ("/"), regardless of
  // host platform — normalizing with the platform-default path module turns
  // a bare "/" into "\\" on Windows, which then fails to match below and
  // serves nothing for the site root.
  const safePath = posix.normalize(requestPath).replace(/^(\.\.\/)+/, "");
  const filePath = join(PUBLIC_DIR, safePath === "/" ? "index.html" : safePath);
  // Stay inside the public dir even if normalize() left a leading "..".
  if (!filePath.startsWith(PUBLIC_DIR)) return false;
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return false;

  const type = CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  createReadStream(filePath).pipe(res);
  return true;
}

/**
 * One open SSE connection per client, polling the DB for events newer than
 * the last one it already sent. Polling (not a DB change feed) because
 * better-sqlite3 is synchronous and has no notification API — at local-tool
 * scale, a 1s poll of an indexed, id-ordered query is unnoticeable and far
 * simpler than wiring up a change bus.
 */
function streamObjectiveEvents(db: Db, req: IncomingMessage, res: ServerResponse, objectiveId: string): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  let lastId = 0;
  const backlog = getObjectiveEvents(db, objectiveId);
  for (const event of backlog) {
    lastId = Math.max(lastId, event.id);
  }
  res.write(`data: ${JSON.stringify({ backlog })}\n\n`);

  const poll = setInterval(() => {
    try {
      const fresh = getObjectiveEvents(db, objectiveId, lastId);
      if (fresh.length > 0) {
        lastId = Math.max(lastId, ...fresh.map((e) => e.id));
        res.write(`data: ${JSON.stringify({ events: fresh })}\n\n`);
      } else {
        res.write(`: heartbeat\n\n`);
      }
    } catch {
      clearInterval(poll);
      res.end();
    }
  }, 1000);

  req.on("close", () => clearInterval(poll));
}

export function createDashboardServer(db: Db) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    try {
      const answerMatch = path.match(/^\/api\/decisions\/([^/]+)\/answer$/);
      if (req.method === "POST" && answerMatch?.[1]) {
        const body = (await readJsonBody(req)) as { answer?: unknown; answeredBy?: unknown };
        const answer = typeof body.answer === "string" ? body.answer : undefined;
        const answeredBy =
          typeof body.answeredBy === "string" && body.answeredBy.trim()
            ? body.answeredBy.trim()
            : "dashboard";
        if (!answer) return sendJson(res, 400, { error: "answer is required" });
        const applied = answerOpenDecision(db, { key: answerMatch[1], answer, answeredBy });
        return applied
          ? sendJson(res, 200, { ok: true })
          : sendJson(res, 409, { ok: false, error: "already answered, or no such decision" });
      }

      if (path === "/api/daemon") {
        return sendJson(res, 200, getDaemonStatus());
      }

      if (path === "/api/objectives") {
        return sendJson(res, 200, listObjectives(db));
      }

      const objectiveMatch = path.match(/^\/api\/objectives\/([^/]+)$/);
      if (objectiveMatch?.[1]) {
        const detail = getObjective(db, objectiveMatch[1]);
        return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: "not found" });
      }

      const eventsMatch = path.match(/^\/api\/objectives\/([^/]+)\/events$/);
      if (eventsMatch?.[1]) {
        const since = url.searchParams.get("afterId");
        return sendJson(res, 200, getObjectiveEvents(db, eventsMatch[1], since ? Number(since) : undefined));
      }

      const streamMatch = path.match(/^\/api\/objectives\/([^/]+)\/stream$/);
      if (streamMatch?.[1]) {
        streamObjectiveEvents(db, req, res, streamMatch[1]);
        return;
      }

      const approvalMatch = path.match(/^\/api\/objectives\/([^/]+)\/approval$/);
      if (approvalMatch?.[1]) {
        return sendJson(res, 200, getApprovalStatus(db, approvalMatch[1]));
      }

      const approveMatch = path.match(/^\/api\/objectives\/([^/]+)\/approve$/);
      if (req.method === "POST" && approveMatch?.[1]) {
        const body = (await readJsonBody(req)) as { approvedBy?: unknown };
        const approvedBy =
          typeof body.approvedBy === "string" && body.approvedBy.trim() ? body.approvedBy.trim() : "dashboard";
        // Merging and pushing shells out to git synchronously and can take a
        // real moment (a push crosses the network) — acceptable for a
        // single-operator local tool, same tradeoff better-sqlite3 already
        // makes everywhere else in this server.
        const result = approveObjective(db, approveMatch[1], approvedBy);
        return sendJson(res, result.ok ? 200 : 409, result);
      }

      if (path === "/api/decisions") {
        return sendJson(res, 200, listOpenDecisions(db));
      }

      if (path === "/api/decisions/history") {
        return sendJson(res, 200, listDecisionHistory(db));
      }

      if (path === "/api/policies") {
        return sendJson(res, 200, listPolicies(db));
      }

      if (path === "/api/profile") {
        return sendJson(res, 200, listProfile(db));
      }

      if (path === "/api/health") {
        const days = Number(url.searchParams.get("days") ?? "7");
        const windowMs = (Number.isFinite(days) && days > 0 ? days : 7) * 24 * 60 * 60 * 1000;
        return sendJson(res, 200, getHealthSnapshot(db, windowMs));
      }

      if (path === "/api/costs") {
        return sendJson(res, 200, getCostRollup(db));
      }

      if (path === "/api/activity") {
        const limit = Number(url.searchParams.get("limit") ?? "80");
        return sendJson(res, 200, listActivity(db, Number.isFinite(limit) && limit > 0 ? limit : 80));
      }

      const reportsMatch = path.match(/^\/api\/objectives\/([^/]+)\/reports$/);
      if (reportsMatch?.[1]) {
        return sendJson(res, 200, getReports(db, reportsMatch[1]));
      }

      const graphMatch = path.match(/^\/api\/objectives\/([^/]+)\/graph$/);
      if (graphMatch?.[1]) {
        const stats = getGraphStats(db, graphMatch[1]);
        return stats ? sendJson(res, 200, stats) : sendJson(res, 404, { error: "not found" });
      }

      if (path.startsWith("/api/")) {
        return sendJson(res, 404, { error: "not found" });
      }

      if (serveStatic(res, path)) return;

      res.writeHead(404).end("not found");
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}
