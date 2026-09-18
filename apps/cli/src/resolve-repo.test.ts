import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepoAt, resolveCreateTarget, resolveRepoFromText, type RepoCandidate } from "./resolve-repo.js";

const REPOS: RepoCandidate[] = [
  { name: "agent", path: "C:\\Users\\dev\\Desktop\\agent" },
  { name: "storefront", path: "C:\\Users\\dev\\Desktop\\storefront" },
  { name: "YUDER-WEB", path: "C:\\Users\\dev\\Desktop\\YUDER-WEB" },
];

describe("resolveRepoFromText", () => {
  it("does not mistake an ordinary word in the sentence for a same-named repo", () => {
    // The exact bug: this project is named "agent", and "agent" is also just an
    // English word — "Hello, agent" as file content must not make this
    // ambiguous with a sentence that also names storefront.
    const result = resolveRepoFromText(
      "Add MAIN.md in storefront with a body of Hello, agent",
      REPOS,
    );
    expect(result.match?.name).toBe("storefront");
    expect(result.ambiguous).toEqual([]);
  });

  it("matches a repo named with a locational preposition", () => {
    for (const prep of ["in", "into", "for", "on", "at", "to", "inside", "within"]) {
      const result = resolveRepoFromText(`add test.md ${prep} storefront`, REPOS);
      expect(result.match?.name).toBe("storefront");
    }
  });

  it("matches through 'the ... repo' phrasing", () => {
    const result = resolveRepoFromText("fix the bug in the storefront repo", REPOS);
    expect(result.match?.name).toBe("storefront");
  });

  it("is genuinely ambiguous when two repos are each named with a preposition", () => {
    const result = resolveRepoFromText("copy the config to agent, then to storefront", REPOS);
    expect(result.match).toBeUndefined();
    expect(result.ambiguous.map((c) => c.name).sort()).toEqual(["agent", "storefront"]);
  });

  it("falls back to a loose scan when no preposition is used", () => {
    const result = resolveRepoFromText("storefront: add a changelog entry", REPOS);
    expect(result.match?.name).toBe("storefront");
  });

  it("reports every known repo, and no match, when nothing is mentioned", () => {
    const result = resolveRepoFromText("refactor the auth module", REPOS);
    expect(result.match).toBeUndefined();
    expect(result.ambiguous).toEqual([]);
    expect(result.known).toHaveLength(3);
  });
});

describe("resolveCreateTarget", () => {
  const ROOTS = ["C:\\Users\\dev\\Desktop"];

  it("resolves an explicit path rooted at a known search root", () => {
    const target = resolveCreateTarget("build it in a folder in Desktop/website", ROOTS);
    expect(target).toBe(join("C:\\Users\\dev\\Desktop", "website"));
  });

  it("resolves a multi-segment path under the root", () => {
    const target = resolveCreateTarget("put it in Desktop/sites/hey-cafe", ROOTS);
    expect(target).toBe(join("C:\\Users\\dev\\Desktop", "sites", "hey-cafe"));
  });

  // The exact case this exists for: no ambiguity between "typo of an existing
  // repo" and "somewhere brand new" once the sentence names a real location.
  it("stays undefined for a bare name with no explicit root — indistinguishable from a typo", () => {
    const target = resolveCreateTarget("add a README in myproject", ROOTS);
    expect(target).toBeUndefined();
  });

  it("stays undefined when the named root isn't one of the known search roots", () => {
    const target = resolveCreateTarget("build it in Documents/website", ROOTS);
    expect(target).toBeUndefined();
  });

  it("stays undefined when nothing looks like a location at all", () => {
    const target = resolveCreateTarget("refactor the auth module", ROOTS);
    expect(target).toBeUndefined();
  });
});

describe("createRepoAt", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "create-repo-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates a fresh repo with a real commit a worktree can branch from", () => {
    const target = join(tmp, "new-project");
    createRepoAt(target);

    const branch = execFileSync("git", ["-C", target, "branch", "--show-current"], { encoding: "utf8" }).trim();
    expect(branch).toBe("main");

    // Confirms HEAD actually resolves — an unborn HEAD (init with no commit)
    // would throw here, and `git worktree add -B <branch> <path> HEAD` would
    // fail exactly the same way on the very first real attempt.
    const head = execFileSync("git", ["-C", target, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("creates intermediate directories that don't exist yet", () => {
    const target = join(tmp, "a", "b", "c");
    createRepoAt(target);
    expect(() => execFileSync("git", ["-C", target, "rev-parse", "HEAD"], { encoding: "utf8" })).not.toThrow();
  });
});
