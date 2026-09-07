import { describe, expect, it } from "vitest";
import type { Policy } from "@exec/core";
import { evaluate, extractCommand, extractPath } from "./engine.js";
import { verdictToHookOutput } from "./hook.js";
import { SEED_POLICIES } from "./seeds.js";

let seq = 0;
const policy = (p: Partial<Policy>): Policy => ({
  id: `p${++seq}`,
  key: `POLICY-${String(seq).padStart(3, "0")}`,
  title: "test policy",
  rationale: "",
  matcher: {},
  severity: "HARD",
  action: "deny",
  scope: "global",
  enabled: true,
  ...p,
  createdAt: p.createdAt ?? Date.now(),
});

const seeded: Policy[] = SEED_POLICIES.map((p, i) =>
  policy({ ...p, id: `s${i}`, key: `POLICY-${String(i + 1).padStart(3, "0")}` }),
);

const bash = (command: string) => ({ tool: "Bash", input: { command } });

describe("extraction", () => {
  it("finds the command and the path across differing argument names", () => {
    expect(extractCommand(bash("ls -la"))).toBe("ls -la");
    expect(extractPath({ tool: "Edit", input: { file_path: "/a/b.ts" } })).toBe("/a/b.ts");
    expect(extractPath({ tool: "Read", input: { path: "/c.ts" } })).toBe("/c.ts");
    expect(extractPath({ tool: "Bash", input: { command: "ls" } })).toBeUndefined();
  });
});

describe("matching", () => {
  it("allows a call nothing matches", () => {
    expect(evaluate(seeded, bash("npm test")).action).toBe("allow");
  });

  it("denies force-push and pushes straight to main", () => {
    expect(evaluate(seeded, bash("git push --force origin feature")).action).toBe("deny");
    expect(evaluate(seeded, bash("git push origin main")).action).toBe("deny");
    // A normal push to a feature branch is untouched.
    expect(evaluate(seeded, bash("git push origin my-feature")).action).toBe("allow");
  });

  it("denies writes to secrets and to the supervisor's own state", () => {
    expect(evaluate(seeded, { tool: "Write", input: { file_path: "/repo/.env" } }).action).toBe("deny");
    expect(evaluate(seeded, { tool: "Edit", input: { file_path: "/repo/.exec/exec.db" } }).action).toBe("deny");
    expect(evaluate(seeded, { tool: "Write", input: { file_path: "/repo/src/env.ts" } }).action).toBe("allow");
  });

  it("normalises Windows separators so one pattern covers both platforms", () => {
    const verdict = evaluate(seeded, {
      tool: "Write",
      input: { file_path: "C:\\repo\\.exec\\exec.db" },
    });
    expect(verdict.action).toBe("deny");
  });

  it("escalates destructive SQL to ask rather than denying it outright", () => {
    expect(evaluate(seeded, bash("psql -c 'drop table users'")).action).toBe("ask");
  });

  it("is case-insensitive on the tool name and the command", () => {
    expect(evaluate(seeded, { tool: "bash", input: { command: "GIT PUSH --FORCE origin x" } }).action).toBe("deny");
  });
});

describe("precedence", () => {
  it("lets the most restrictive matching policy win regardless of order", () => {
    const permissive = policy({ matcher: { tool: "Bash" }, action: "allow", severity: "SOFT" });
    const strict = policy({ matcher: { tool: "Bash", commandPattern: "rm -rf" }, action: "deny" });

    expect(evaluate([permissive, strict], bash("rm -rf /")).action).toBe("deny");
    expect(evaluate([strict, permissive], bash("rm -rf /")).action).toBe("deny");
  });

  it("ignores disabled policies", () => {
    const disabled = policy({ matcher: { tool: "Bash" }, action: "deny", enabled: false });
    expect(evaluate([disabled], bash("ls")).action).toBe("allow");
  });

  it("ignores a matcher with no fields set, rather than governing everything", () => {
    const empty = policy({ matcher: {}, action: "deny" });
    expect(evaluate([empty], bash("ls")).action).toBe("allow");
  });
});

describe("failure modes", () => {
  it("fails closed when a HARD policy has an invalid pattern", () => {
    const broken = policy({ matcher: { commandPattern: "([unclosed" }, severity: "HARD" });
    const verdict = evaluate([broken], bash("ls"));
    expect(verdict.action).toBe("deny");
    expect(verdict.reason).toMatch(/could not be evaluated/);
  });

  it("skips a SOFT policy with an invalid pattern instead of blocking work", () => {
    const broken = policy({ matcher: { commandPattern: "([unclosed" }, severity: "SOFT", action: "warn" });
    expect(evaluate([broken], bash("ls")).action).toBe("allow");
  });
});

describe("hook output", () => {
  it("maps deny to a harness-enforced denial with anti-workaround guidance", () => {
    const out = verdictToHookOutput(evaluate(seeded, bash("git push --force origin main")));
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.systemMessage).toMatch(/request_decision/);
  });

  it("maps warn to an allow that still surfaces the note", () => {
    const out = verdictToHookOutput(evaluate(seeded, bash("npm install left-pad")));
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.systemMessage).toMatch(/Policy note/);
  });
});
