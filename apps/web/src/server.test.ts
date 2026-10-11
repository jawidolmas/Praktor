import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, runMigrations, type Db } from "@exec/db";
import { createDashboardServer } from "./server.js";

/**
 * Real HTTP against a real server on an ephemeral loopback port — the
 * guards here depend on actual sockets and headers, so mocks would prove
 * nothing. `node:http` rather than fetch because fetch can't set Host.
 */

interface Reply {
  status: number;
  body: any;
}

let db: Db;
let server: Server;
let port: number;

function call(method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Reply> {
  return new Promise((resolvePromise, rejectPromise) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const r = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          host: `127.0.0.1:${port}`,
          ...(payload !== undefined ? { "content-type": "application/json" } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c: Buffer) => (text += c.toString("utf8")));
        res.on("end", () => {
          let body: unknown = text;
          try {
            body = JSON.parse(text);
          } catch {
            /* not JSON */
          }
          resolvePromise({ status: res.statusCode ?? 0, body });
        });
      },
    );
    r.on("error", rejectPromise);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

beforeEach(async () => {
  db = openDb({ path: ":memory:" }).db;
  runMigrations(db);
  server = createDashboardServer(db);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("local dashboard guard", () => {
  it("serves the dashboard API to this machine", async () => {
    expect((await call("GET", "/api/objectives")).status).toBe(200);
  });

  it("refuses a foreign Host header (DNS rebinding)", async () => {
    expect((await call("GET", "/api/objectives", { headers: { host: `evil.example:${port}` } })).status).toBe(403);
  });

  it("refuses requests relayed by a reverse proxy", async () => {
    for (const h of ["x-forwarded-for", "forwarded", "tailscale-user-login"]) {
      expect((await call("GET", "/api/objectives", { headers: { [h]: "1.2.3.4" } })).status).toBe(403);
    }
  });

  it("refuses a cross-site POST, even with a text/plain body", async () => {
    const textPlain = await call("POST", "/api/decisions/DEC-1/answer", {
      body: { answer: "yes" },
      headers: { "content-type": "text/plain" },
    });
    expect(textPlain.status).toBe(403);
    const foreign = await call("POST", "/api/decisions/DEC-1/answer", {
      body: { answer: "yes" },
      headers: { origin: "https://evil.example" },
    });
    expect(foreign.status).toBe(403);
  });

  it("sets hardening headers", async () => {
    const res = await new Promise<import("node:http").IncomingMessage>((r) =>
      request({ host: "127.0.0.1", port, path: "/api/objectives", headers: { host: `127.0.0.1:${port}` } }, r).end(),
    );
    res.resume();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});
