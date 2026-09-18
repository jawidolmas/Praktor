import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "./worktree.js";
import {
  checkGraphifyInstalled,
  ensureGraphForRepo,
  graphCacheDirFor,
  graphJsonPathFor,
  graphsDir,
  hashRepoPath,
  resetGraphifyInstallCache,
} from "./graphify.js";

describe("graphsDir / hashRepoPath / graphCacheDirFor / graphJsonPathFor", () => {
  const ORIGINAL_ENV = process.env["EXEC_GRAPHS_DIR"];
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env["EXEC_GRAPHS_DIR"];
    else process.env["EXEC_GRAPHS_DIR"] = ORIGINAL_ENV;
  });

  it("defaults under ~/.exec-agent, override-able via EXEC_GRAPHS_DIR", () => {
    delete process.env["EXEC_GRAPHS_DIR"];
    expect(graphsDir()).toMatch(/\.exec-agent[\\/]graphs$/);

    process.env["EXEC_GRAPHS_DIR"] = "/tmp/custom-graphs";
    expect(graphsDir()).toBe(resolve("/tmp/custom-graphs"));
  });

  it("hashes the same repo path to the same key, and different paths to different keys", () => {
    const a = hashRepoPath("/some/repo");
    const b = hashRepoPath("/some/repo");
    const c = hashRepoPath("/some/other-repo");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("nests graph.json under a per-repo cache directory, not the repo itself", () => {
    const graphPath = graphJsonPathFor("/some/repo");
    const cacheDir = graphCacheDirFor("/some/repo");
    expect(graphPath).toBe(join(cacheDir, "graph.json"));
    expect(cacheDir.startsWith(graphsDir())).toBe(true);
  });
});

describe("checkGraphifyInstalled", () => {
  beforeEach(() => resetGraphifyInstallCache());
  afterEach(() => resetGraphifyInstallCache());

  it("reports whether graphify is on PATH, with an install hint when it isn't", () => {
    const result = checkGraphifyInstalled();
    if (!result.ok) {
      expect(result.message).toContain("uv tool install");
    } else {
      expect(result.message).toBeUndefined();
    }
  });

  it("caches the result across calls within a process", () => {
    const first = checkGraphifyInstalled();
    const second = checkGraphifyInstalled();
    expect(second).toBe(first); // same object identity — not re-checked
  });
});

// graphify itself is an external dependency (a separate Python CLI) — these
// exercise the real subprocess against a throwaway repo when it's actually
// installed on the machine running the suite, and skip with a clear warning
// otherwise, the same courtesy worktree.test.ts's real-git tests get for
// free from git being all but universally present.
const graphifyAvailable = (() => {
  try {
    execFileSync("graphify", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(graphifyAvailable)("ensureGraphForRepo (real graphify subprocess)", () => {
  let repoPath: string;

  beforeEach(() => {
    resetGraphifyInstallCache();
    repoPath = mkdtempSync(join(tmpdir(), "graphify-test-"));
    git(repoPath, ["init", "-q", "-b", "main"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "user.name", "Test"]);
    writeFileSync(
      join(repoPath, "main.ts"),
      "export function greet(name: string): string {\n  return `hello ${name}`;\n}\n",
    );
    git(repoPath, ["add", "-A"]);
    git(repoPath, ["commit", "-q", "-m", "init"]);
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
    rmSync(graphCacheDirFor(repoPath), { recursive: true, force: true });
  });

  it("builds a graph.json with at least one node, outside the repo itself", () => {
    const result = ensureGraphForRepo(repoPath);

    expect(result.available).toBe(true);
    expect(result.graphPath).toBe(graphJsonPathFor(repoPath));
    expect(result.graphPath.startsWith(repoPath)).toBe(false);

    const graph = JSON.parse(readFileSync(result.graphPath, "utf8"));
    expect(Array.isArray(graph.nodes)).toBe(true);
    expect(graph.nodes.length).toBeGreaterThan(0);
  });
});

if (!graphifyAvailable) {
  console.warn(
    "graphify not found on PATH — skipping ensureGraphForRepo's real-subprocess test. " +
      "Install with: uv tool install 'graphifyy[mcp]'",
  );
}
