import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "@exec/db";
import {
  getObjective,
  getObjectiveEvents,
  listObjectives,
  listOpenDecisions,
  listPolicies,
} from "./api.js";

const PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "public");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

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
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    try {
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

      if (path === "/api/decisions") {
        return sendJson(res, 200, listOpenDecisions(db));
      }

      if (path === "/api/policies") {
        return sendJson(res, 200, listPolicies(db));
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
