import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newId } from "@exec/core";
import { objectives, openDb, runMigrations, runs, tasks, type Db } from "@exec/db";
import { attemptBranchName } from "@exec/worker";
import { getAgentTree, parseNameStatusZ } from "./api.js";
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
  server = createDashboardServer(db, { publicUrl: () => ({ ok: true, url: "https://box.tail1.ts.net" }) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function pairDevice(name = "iPhone"): Promise<string> {
  const shown = await call("POST", "/api/pairing", { body: {} });
  expect(shown.status).toBe(200);
  const code = new URL(shown.body.link).searchParams.get("code")!;
  const paired = await call("POST", "/api/v1/pair", { body: { code, deviceName: name } });
  expect(paired.status).toBe(201);
  return paired.body.token;
}

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

describe("/api/v1", () => {
  it("requires a token on every route", async () => {
    for (const path of ["/api/v1/me", "/api/v1/objectives", "/api/v1/objectives/abc/tree", "/api/v1/daemon"]) {
      expect((await call("GET", path)).status).toBe(401);
      expect((await call("GET", path, { headers: { authorization: "Bearer pk_forged" } })).status).toBe(401);
    }
  });

  it("requires a token even through a proxy that hits the local guard's blind spot", async () => {
    expect((await call("GET", "/api/v1/objectives", { headers: { "x-forwarded-for": "1.2.3.4" } })).status).toBe(401);
  });

  it("pairs a device end to end and serves it", async () => {
    const token = await pairDevice("Jawid's iPhone");
    const me = await call("GET", "/api/v1/me", { headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ apiVersion: 1, device: { name: "Jawid's iPhone" } });
    expect((await call("GET", "/api/v1/objectives", { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  it("puts the public URL in the pairing link", async () => {
    const shown = await call("POST", "/api/pairing", { body: {} });
    const link = new URL(shown.body.link);
    expect(link.protocol).toBe("praktor:");
    expect(link.searchParams.get("url")).toBe("https://box.tail1.ts.net");
    expect(shown.body.qrSvg).toContain("<svg");
  });

  it("won't redeem a pairing code twice", async () => {
    const shown = await call("POST", "/api/pairing", { body: {} });
    const code = new URL(shown.body.link).searchParams.get("code")!;
    expect((await call("POST", "/api/v1/pair", { body: { code, deviceName: "a" } })).status).toBe(201);
    expect((await call("POST", "/api/v1/pair", { body: { code, deviceName: "b" } })).status).toBe(401);
  });

  it("rejects a pairing request without a usable name", async () => {
    const shown = await call("POST", "/api/pairing", { body: {} });
    const code = new URL(shown.body.link).searchParams.get("code")!;
    expect((await call("POST", "/api/v1/pair", { body: { code, deviceName: "\u0000" } })).status).toBe(400);
  });

  it("refuses to show a pairing code to anyone but this machine", async () => {
    expect((await call("POST", "/api/pairing", { body: {}, headers: { "x-forwarded-for": "1.2.3.4" } })).status).toBe(403);
  });

  it("rate-limits pairing attempts", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await call("POST", "/api/v1/pair", { body: { code: "guess", deviceName: "x" } })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it("cuts off a revoked device immediately", async () => {
    const token = await pairDevice();
    const [device] = (await call("GET", "/api/devices")).body;
    expect((await call("POST", `/api/devices/${device.id}/revoke`, { body: {} })).status).toBe(200);
    expect((await call("GET", "/api/v1/me", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it("is read-only", async () => {
    const token = await pairDevice();
    const auth = { authorization: `Bearer ${token}` };
    expect((await call("POST", "/api/v1/objectives", { headers: auth, body: {} })).status).toBe(405);
  });

  it("never reaches a query with a malformed id", async () => {
    const token = await pairDevice();
    const r = await call("GET", "/api/v1/objectives/..%2F..%2Fetc/tree", { headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(404);
  });
});

describe("parseNameStatusZ", () => {
  it("parses plain changes and renames", () => {
    expect(parseNameStatusZ("M\0src/a.ts\0R087\0old.ts\0new.ts\0A\0b c.ts\0")).toEqual([
      { status: "M", path: "src/a.ts" },
      { status: "R", path: "new.ts", oldPath: "old.ts" },
      { status: "A", path: "b c.ts" },
    ]);
  });
});

describe("getAgentTree", () => {
  let repo: string;

  function git(...args: string[]): void {
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
  }

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "praktor-tree-"));
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    writeFileSync(join(repo, "README.md"), "hi\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("lists the attempt branch's files and what it changed", () => {
    const objectiveId = newId();
    const taskId = newId();
    const budget = { maxTurns: 1, maxTokens: 1, maxWallClockMs: 1 };
    db.insert(objectives).values({ id: objectiveId, title: "o", repoPath: repo, baseRef: "main", budget }).run();
    db.insert(tasks)
      .values({
        id: taskId, objectiveId, key: "T-001", title: "add feature", intent: "x", taskClass: "implement",
        acceptance: { checks: [] }, budget, status: "done",
      })
      .run();
    db.insert(runs)
      .values({
        id: newId(), taskId, objectiveId, attempt: 2, sessionId: newId(), model: "m", worktreePath: "/w",
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      })
      .run();

    const branch = attemptBranchName(taskId, 2);
    git("checkout", "-q", "-b", branch);
    writeFileSync(join(repo, "feature.ts"), "export {}\n");
    writeFileSync(join(repo, "README.md"), "changed\n");
    git("add", ".");
    git("commit", "-q", "-m", "work");
    git("checkout", "-q", "main");

    const tree = getAgentTree(db, objectiveId)!;
    expect(tree.baseRef).toBe("main");
    expect(tree.tasks).toHaveLength(1);
    const t = tree.tasks[0]!;
    expect(t).toMatchObject({ available: true, attempt: 2, branch, truncated: false });
    expect(t.files.sort()).toEqual(["README.md", "feature.ts"]);
    expect(t.changes).toEqual(
      expect.arrayContaining([
        { status: "A", path: "feature.ts" },
        { status: "M", path: "README.md" },
      ]),
    );
  });

  it("explains a task that never ran", () => {
    const objectiveId = newId();
    const budget = { maxTurns: 1, maxTokens: 1, maxWallClockMs: 1 };
    db.insert(objectives).values({ id: objectiveId, title: "o", repoPath: repo, baseRef: "main", budget }).run();
    db.insert(tasks)
      .values({
        id: newId(), objectiveId, key: "T-001", title: "t", intent: "x", taskClass: "implement",
        acceptance: { checks: [] }, budget,
      })
      .run();
    expect(getAgentTree(db, objectiveId)!.tasks[0]).toMatchObject({ available: false, files: [] });
  });
});
