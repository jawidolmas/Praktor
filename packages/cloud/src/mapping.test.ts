import { describe, expect, it } from "vitest";
import type { EventRow } from "@exec/db";
import { LOCAL_ONLY_EVENT_TYPES, clip, repoName, toCloudAgentFiles, toCloudEvent } from "./mapping.js";

const stamp = { owner_id: "owner", host_id: "host" };

function event(payload: EventRow["payload"], id = 1): EventRow {
  return { id, ts: 1, level: "info", objectiveId: "o", taskId: "t", runId: "r", type: payload.type, payload };
}

describe("repoName", () => {
  it("keeps only the folder name, never this machine's full path", () => {
    expect(repoName("C:\\Users\\jawid\\Desktop\\praktor")).toBe("praktor");
    expect(repoName("/home/jawid/src/praktor/")).toBe("praktor");
  });
});

describe("clip", () => {
  it("cuts to the limit and marks the cut", () => {
    expect(clip("abcdef", 4)).toBe("abc…");
    expect(clip("abc", 4)).toBe("abc");
  });
});

describe("toCloudEvent (sync level B)", () => {
  it("never sends the worker's own narration, which can quote source code", () => {
    const secretCode = "const apiKey = 'sk-live-123'";
    expect(toCloudEvent(event({ type: "run.message", text: secretCode }), stamp)).toBeUndefined();
  });

  it("drops every local-only type", () => {
    for (const type of LOCAL_ONLY_EVENT_TYPES) {
      expect(toCloudEvent({ ...event({ type: "note", message: "x" }), type }, stamp)).toBeUndefined();
    }
  });

  it("sends a readable one-line summary, not the raw payload", () => {
    const row = toCloudEvent(event({ type: "task.status_changed", from: "running", to: "done" }), stamp)!;
    expect(row).toMatchObject({ owner_id: "owner", host_id: "host", id: 1, type: "task.status_changed" });
    expect(typeof row.text).toBe("string");
    expect(row).not.toHaveProperty("payload");
  });

  it("bounds the summary to the relay's column limit", () => {
    const row = toCloudEvent(event({ type: "note", message: "x".repeat(5000) }), stamp)!;
    expect(row.text.length).toBeLessThanOrEqual(2000);
  });
});

describe("toCloudAgentFiles", () => {
  it("sends paths and change letters only", () => {
    const rows = toCloudAgentFiles(
      "obj",
      {
        taskId: "t1",
        attempt: 2,
        branch: "b",
        available: true,
        truncated: false,
        changes: [
          { status: "A", path: "src/new.ts" },
          { status: "R", path: "b.ts", oldPath: "a.ts" },
        ],
      },
      stamp,
    );
    expect(rows).toEqual([
      { ...stamp, task_id: "t1", path: "src/new.ts", objective_id: "obj", attempt: 2, change: "A", old_path: null },
      { ...stamp, task_id: "t1", path: "b.ts", objective_id: "obj", attempt: 2, change: "R", old_path: "a.ts" },
    ]);
  });

  it("drops anything the relay would reject instead of failing the whole batch", () => {
    const rows = toCloudAgentFiles(
      "obj",
      {
        taskId: "t1",
        attempt: 1,
        branch: "b",
        available: true,
        truncated: false,
        changes: [
          { status: "M", path: "dup.ts" },
          { status: "M", path: "dup.ts" },
          { status: "B", path: "unknown-letter.ts" },
          { status: "A", path: "x".repeat(2000) },
        ],
      },
      stamp,
    );
    expect(rows.map((r) => r.path)).toEqual(["dup.ts"]);
  });
});
