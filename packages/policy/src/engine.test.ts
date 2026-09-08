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

  it("still denies a push to main phrased with git's own -C flag", () => {
    // The real bug: the single-pattern version required "push" immediately
    // after "git", so this — the worker's own idiomatic phrasing, seen live,
    // not a contrived edge case — sailed through as an unmatched, allowed call.
    const real = 'git -C "C:/Users/USER/Desktop/takil-workspace" push origin main && git -C "C:/Users/USER/Desktop/takil-workspace" status';
    expect(evaluate(seeded, bash(real)).action).toBe("deny");
  });

  it("denies push-to-protected-branch under other common refspec and flag forms", () => {
    expect(evaluate(seeded, bash("git push origin HEAD:main")).action).toBe("deny");
    expect(evaluate(seeded, bash("git --git-dir=/repo/.git push origin master")).action).toBe("deny");
    expect(evaluate(seeded, bash("git push -f origin main")).action).toBe("deny");
    expect(evaluate(seeded, bash("git push --force-with-lease origin main")).action).toBe("deny");
  });

  it("does not over-block a push to a feature branch just for using -C", () => {
    const benign = 'git -C "C:/repo" push origin my-feature-branch';
    expect(evaluate(seeded, bash(benign)).action).toBe("allow");
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

describe("array commandPattern (AND semantics)", () => {
  it("requires every pattern to match, not just one", () => {
    const both = policy({ matcher: { tool: "Bash", commandPattern: ["foo", "bar"] } });
    expect(evaluate([both], bash("foo baz")).action).toBe("allow"); // only "foo"
    expect(evaluate([both], bash("bar baz")).action).toBe("allow"); // only "bar"
    expect(evaluate([both], bash("foo and bar")).action).toBe("deny"); // both
  });

  it("does not require the patterns to be adjacent or in order", () => {
    const both = policy({ matcher: { tool: "Bash", commandPattern: ["push", "origin"] } });
    expect(evaluate([both], bash("git -C /x push origin main")).action).toBe("deny");
    expect(evaluate([both], bash("git fetch origin && git push")).action).toBe("deny");
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
