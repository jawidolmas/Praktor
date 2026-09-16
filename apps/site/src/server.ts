import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { extname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "public");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

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

export function createSiteServer() {
  return createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (serveStatic(res, path)) return;
    res.writeHead(404).end("not found");
  });
}
