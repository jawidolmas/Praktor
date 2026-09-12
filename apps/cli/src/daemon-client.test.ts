import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocks only the `isAlive` seen by daemon-client.ts's own polling loop.
// `findRunningDaemon` (spread in from the real module below) calls its own
// module-local `isAlive` inside @exec/db, so it still sees the real process —
// only daemon-client's liveness check after signaling is forced to stay
// "true", simulating a process that doesn't die on SIGTERM without relying on
// OS-specific signal-ignoring behavior (which Windows' unconditional
// TerminateProcess makes impossible to produce for real).
const isAliveMock = vi.hoisted(() => vi.fn());

vi.mock("@exec/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@exec/db")>();
  return { ...actual, isAlive: isAliveMock };
});

const { pidFilePath } = await import("@exec/db");
const { stopDaemon } = await import("./daemon-client.js");

let home: string;
let originalHome: string | undefined;
let child: ChildProcess | undefined;

beforeEach(() => {
  originalHome = process.env["EXEC_HOME"];
  home = mkdtempSync(join(tmpdir(), "exec-agent-test-"));
  process.env["EXEC_HOME"] = home;
  isAliveMock.mockReset();
});

afterEach(() => {
  child?.kill();
  child = undefined;
  if (originalHome === undefined) delete process.env["EXEC_HOME"];
  else process.env["EXEC_HOME"] = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe("stopDaemon", () => {
  it("reports not running when there is no pidfile", async () => {
    isAliveMock.mockReturnValue(false);
    await expect(stopDaemon()).resolves.toEqual({ stopped: false });
  });

  it("does not report success until the process has actually exited", async () => {
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise((res) => setTimeout(res, 100)); // let it actually start
    writeFileSync(pidFilePath(), String(child.pid), "utf8");
    isAliveMock.mockImplementation((pid: number) => {
      // Real answer: false once the SIGTERM below has actually taken effect.
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });

    const result = await stopDaemon({ timeoutMs: 3_000, pollIntervalMs: 20 });

    expect(result).toEqual({ stopped: true, pid: child.pid, confirmed: true });
  });

  it('reports confirmed:false rather than lying, when the process is still alive at the deadline', async () => {
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise((res) => setTimeout(res, 100));
    writeFileSync(pidFilePath(), String(child.pid), "utf8");
    isAliveMock.mockReturnValue(true); // simulate a process that never dies

    const result = await stopDaemon({ timeoutMs: 200, pollIntervalMs: 20 });

    expect(result).toEqual({ stopped: true, pid: child.pid, confirmed: false });
  });
});
