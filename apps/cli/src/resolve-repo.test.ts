import { describe, expect, it } from "vitest";
import { resolveRepoFromText, type RepoCandidate } from "./resolve-repo.js";

const REPOS: RepoCandidate[] = [
  { name: "agent", path: "C:\\Users\\USER\\Desktop\\agent" },
  { name: "takil-workspace", path: "C:\\Users\\USER\\Desktop\\takil-workspace" },
  { name: "YUDER-WEB", path: "C:\\Users\\USER\\Desktop\\YUDER-WEB" },
];

describe("resolveRepoFromText", () => {
  it("does not mistake an ordinary word in the sentence for a same-named repo", () => {
    // The exact bug: this project is named "agent", and "agent" is also just an
    // English word — "Hello, agent" as file content must not make this
    // ambiguous with a sentence that also names takil-workspace.
    const result = resolveRepoFromText(
      "Add MAIN.md in takil-workspace with a body of Hello, agent",
      REPOS,
    );
    expect(result.match?.name).toBe("takil-workspace");
    expect(result.ambiguous).toEqual([]);
  });

  it("matches a repo named with a locational preposition", () => {
    for (const prep of ["in", "into", "for", "on", "at", "to", "inside", "within"]) {
      const result = resolveRepoFromText(`add test.md ${prep} takil-workspace`, REPOS);
      expect(result.match?.name).toBe("takil-workspace");
    }
  });

  it("matches through 'the ... repo' phrasing", () => {
    const result = resolveRepoFromText("fix the bug in the takil-workspace repo", REPOS);
    expect(result.match?.name).toBe("takil-workspace");
  });

  it("is genuinely ambiguous when two repos are each named with a preposition", () => {
    const result = resolveRepoFromText("copy the config to agent, then to takil-workspace", REPOS);
    expect(result.match).toBeUndefined();
    expect(result.ambiguous.map((c) => c.name).sort()).toEqual(["agent", "takil-workspace"]);
  });

  it("falls back to a loose scan when no preposition is used", () => {
    const result = resolveRepoFromText("takil-workspace: add a changelog entry", REPOS);
    expect(result.match?.name).toBe("takil-workspace");
  });

  it("reports every known repo, and no match, when nothing is mentioned", () => {
    const result = resolveRepoFromText("refactor the auth module", REPOS);
    expect(result.match).toBeUndefined();
    expect(result.ambiguous).toEqual([]);
    expect(result.known).toHaveLength(3);
  });
});
