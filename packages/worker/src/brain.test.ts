import { describe, expect, it } from "vitest";
import { buildDiagnoserPrompt, buildPlannerPrompt, buildReviewerPrompt } from "./brain.js";

const PROFILE = [{ title: "Dependencies", content: "Avoid unnecessary dependencies." }];

describe("buildPlannerPrompt", () => {
  it("includes the engineering profile when one is given, and omits it when not", () => {
    const withProfile = buildPlannerPrompt(
      { title: "Add a feature", brief: "", repoPath: "/tmp/repo", model: "m", profile: PROFILE },
      "",
    );
    expect(withProfile).toContain("Dependencies: Avoid unnecessary dependencies.");

    const without = buildPlannerPrompt({ title: "Add a feature", brief: "", repoPath: "/tmp/repo", model: "m" }, "");
    expect(without).not.toContain("Standing engineering profile");
  });
});

describe("buildReviewerPrompt", () => {
  it("includes the engineering profile alongside the diff and acceptance summary", () => {
    const prompt = buildReviewerPrompt(
      {
        taskTitle: "T", intent: "do it", worktreePath: "/tmp/wt", baseSha: "abc", model: "m",
        verify: { passed: true, checks: [] },
        profile: PROFILE,
      },
      "",
      "diff --git a/x b/x",
    );
    expect(prompt).toContain("Dependencies: Avoid unnecessary dependencies.");
    expect(prompt).toContain("diff --git a/x b/x");
  });

  it("tells the judge to check blast radius with graphify tools when a graph is available", () => {
    const withGraph = buildReviewerPrompt(
      {
        taskTitle: "T", intent: "do it", worktreePath: "/tmp/wt", baseSha: "abc", model: "m",
        verify: { passed: true, checks: [] },
        graphPath: "/graphs/abc/graph.json",
      },
      "",
      "",
    );
    expect(withGraph).toContain("shortest_path");

    const withoutGraph = buildReviewerPrompt(
      { taskTitle: "T", intent: "do it", worktreePath: "/tmp/wt", baseSha: "abc", model: "m", verify: { passed: true, checks: [] } },
      "",
      "",
    );
    expect(withoutGraph).not.toContain("shortest_path");
  });
});

describe("buildDiagnoserPrompt", () => {
  it("includes the engineering profile alongside the failure detail", () => {
    const prompt = buildDiagnoserPrompt(
      {
        taskTitle: "T", intent: "do it", worktreePath: "/tmp/wt", model: "m", ruledOut: [],
        stallSignal: { signal: "no_churn", detail: "5 turns, no change" },
        profile: PROFILE,
      },
      "",
    );
    expect(prompt).toContain("Dependencies: Avoid unnecessary dependencies.");
    expect(prompt).toContain("no_churn");
  });

  it("tells the diagnoser to check outside the attempt's own diff with graphify tools when available", () => {
    const withGraph = buildDiagnoserPrompt(
      {
        taskTitle: "T", intent: "do it", worktreePath: "/tmp/wt", model: "m", ruledOut: [],
        exitReason: "error",
        graphPath: "/graphs/abc/graph.json",
      },
      "",
    );
    expect(withGraph).toContain("get_neighbors");

    const withoutGraph = buildDiagnoserPrompt(
      { taskTitle: "T", intent: "do it", worktreePath: "/tmp/wt", model: "m", ruledOut: [], exitReason: "error" },
      "",
    );
    expect(withoutGraph).not.toContain("get_neighbors");
  });
});
