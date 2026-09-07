import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * check-exists.mjs is a standalone script (not a TS module the worker driver
 * imports) — it runs as an acceptance-check shell command, so it's tested the
 * same way it's actually invoked: as a child process.
 */

const scriptPath = join(import.meta.dirname, "check-exists.mjs");
const run = (target: string) => spawnSync(process.execPath, [scriptPath, target], { encoding: "utf8" });

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "check-exists-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("check-exists.mjs", () => {
  it("exits 0 for an existing, non-empty file", () => {
    const file = join(dir, "real.md");
    writeFileSync(file, "content");
    expect(run(file).status).toBe(0);
  });

  it("exits 1 for a missing file", () => {
    expect(run(join(dir, "missing.md")).status).toBe(1);
  });

  it("exits 1 for an existing but empty file", () => {
    const file = join(dir, "empty.md");
    writeFileSync(file, "");
    expect(run(file).status).toBe(1);
  });

  it("does not treat a different-case existing file as a match", () => {
    // The exact bug: on a case-insensitive filesystem, existsSync("test.md")
    // alone resolves to an existing "TEST.md" too. A request for a NEW
    // "test.md" that collides with an already-existing "TEST.md" must not
    // falsely pass off the pre-existing file.
    writeFileSync(join(dir, "TEST.md"), "original content");
    expect(run(join(dir, "test.md")).status).toBe(1);
  });

  it("still passes for the exact case that really exists", () => {
    writeFileSync(join(dir, "TEST.md"), "original content");
    expect(run(join(dir, "TEST.md")).status).toBe(0);
  });
});
