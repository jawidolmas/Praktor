import { describe, expect, it } from "vitest";
import { buildMcpServers, buildPrompt } from "./driver.js";
import { createSupervisorTools } from "./tools.js";

/**
 * Regression test for a real failure: a worker asked to "ask me a question
 * in telegram" searched for a matching tool, never found `request_decision`
 * (its description didn't contain any word the worker searched for), and
 * gave up — writing a placeholder file and explaining it had no way to
 * reach the person, instead of just calling the tool that exists for
 * exactly this. The prompt itself naming `request_decision` by its exact
 * tool name is what makes it findable regardless of search wording.
 */
describe("buildPrompt", () => {
  it("always tells the worker request_decision exists and when to use it", () => {
    const prompt = buildPrompt({ intent: "Do something", ruledOut: [] }, "");
    expect(prompt).toContain("request_decision");
    expect(prompt.toLowerCase()).toContain("check with");
  });

  it("still includes the intent, ruled-out list, and checkpoint note", () => {
    const prompt = buildPrompt(
      { intent: "Do something", ruledOut: ["approach A"], checkpointNote: "carried over" },
      "briefing text",
    );
    expect(prompt).toContain("briefing text");
    expect(prompt).toContain("Do something");
    expect(prompt).toContain("approach A");
    expect(prompt).toContain("carried over");
  });

  it("includes the standing engineering profile when one is given", () => {
    const prompt = buildPrompt(
      { intent: "Do something", ruledOut: [], profile: [{ title: "Dependencies", content: "Avoid new ones." }] },
      "",
    );
    expect(prompt).toContain("Dependencies: Avoid new ones.");
  });

  it("omits the profile section entirely when none is given", () => {
    const prompt = buildPrompt({ intent: "Do something", ruledOut: [] }, "");
    expect(prompt).not.toContain("Standing engineering profile");
  });
});

describe("buildMcpServers", () => {
  const supervisorServer = createSupervisorTools({
    requestDecision: async () => ({ outcome: "timed_out" as const, decisionKey: "n/a" }),
    reportProgress: () => {},
    recordFinding: () => {},
    loadPolicies: () => [],
  });

  it("wires up only the exec server when no graph is available", () => {
    const servers = buildMcpServers(supervisorServer);
    expect(servers).toEqual({ exec: supervisorServer });
  });

  it("adds a graphify stdio MCP server pointed at the graph when one is given", () => {
    const servers = buildMcpServers(supervisorServer, "/repo-cache/graph.json");
    expect(servers).toEqual({
      exec: supervisorServer,
      graphify: { command: "graphify-mcp", args: ["/repo-cache/graph.json"] },
    });
  });
});
