import { describe, expect, it } from "vitest";
import { resolveRepoFromText, type RepoCandidate } from "./resolve-repo.js";

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
