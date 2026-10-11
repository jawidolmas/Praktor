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
