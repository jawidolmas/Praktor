import { describe, expect, it } from "vitest";
import { buildBriefingFromInput, renderBriefing } from "./briefing.js";

const noop = () => undefined;

describe("buildBriefingFromInput", () => {
  it("sorts by depth first, then alphabetically — root files before nested ones", () => {
    const briefing = buildBriefingFromInput({
      trackedFiles: ["src/deep/nested/file.ts", "b.md", "a.md", "src/index.ts"],
      readDoc: noop,
    });
    expect(briefing.fileList).toEqual(["a.md", "b.md", "src/index.ts", "src/deep/nested/file.ts"]);
  });

  it("caps the file list and reports the true total", () => {
    const files = Array.from({ length: 300 }, (_, i) => `file${String(i).padStart(3, "0")}.ts`);
    const briefing = buildBriefingFromInput({ trackedFiles: files, readDoc: noop });
    expect(briefing.fileList).toHaveLength(150);
    expect(briefing.fileListTotal).toBe(300);
  });

  it("includes only doc candidates that actually exist", () => {
    const briefing = buildBriefingFromInput({
      trackedFiles: [],
      readDoc: (name) => (name === "README.md" ? "hello" : undefined),
    });
    expect(briefing.docExcerpts).toEqual([{ file: "README.md", excerpt: "hello", truncated: false }]);
  });

  it("truncates an overlong doc and flags it", () => {
    const long = "x".repeat(2000);
    const briefing = buildBriefingFromInput({
      trackedFiles: [],
      readDoc: (name) => (name === "README.md" ? long : undefined),
    });
    const readme = briefing.docExcerpts[0]!;
    expect(readme.truncated).toBe(true);
    expect(readme.excerpt.length).toBe(1200);
  });

  it("handles an empty repo without error", () => {
    const briefing = buildBriefingFromInput({ trackedFiles: [], readDoc: noop });
    expect(briefing.fileList).toEqual([]);
    expect(briefing.docExcerpts).toEqual([]);
  });
});

describe("renderBriefing", () => {
  it("renders nothing for an empty briefing", () => {
    expect(renderBriefing(buildBriefingFromInput({ trackedFiles: [], readDoc: noop }))).toBe("");
  });

  it("notes how many files were omitted when the list was capped", () => {
    const files = Array.from({ length: 200 }, (_, i) => `f${i}.ts`);
    const text = renderBriefing(buildBriefingFromInput({ trackedFiles: files, readDoc: noop }));
    expect(text).toMatch(/first 150 of 200/);
  });

  it("includes doc content verbatim so the worker doesn't need to re-read it", () => {
    const text = renderBriefing(
      buildBriefingFromInput({
        trackedFiles: ["README.md"],
        readDoc: (name) => (name === "README.md" ? "This repo is not the app source." : undefined),
      }),
    );
    expect(text).toMatch(/This repo is not the app source\./);
  });

  it("steers the worker toward graphify's MCP tools when a graph is available", () => {
    const text = renderBriefing({ ...buildBriefingFromInput({ trackedFiles: [], readDoc: noop }), graphAvailable: true });
    expect(text).toContain("query_graph");
    expect(text).toContain("shortest_path");
  });

  it("omits the graphify paragraph when no graph is available", () => {
    const text = renderBriefing(
      buildBriefingFromInput({ trackedFiles: ["README.md"], readDoc: () => "content" }),
    );
    expect(text).not.toContain("query_graph");
  });

  it("still renders the graphify paragraph even with nothing else in the briefing", () => {
    const text = renderBriefing({ ...buildBriefingFromInput({ trackedFiles: [], readDoc: noop }), graphAvailable: true });
    expect(text).not.toBe("");
  });
});
