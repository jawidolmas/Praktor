import type { AcceptanceCheck, EffortLevel, ObjectiveOnFailure } from "@exec/core";

const VALID_ON_FAILURE = new Set<string>(["escalate", "abandon", "skip"]);

/**
 * Argument parsing, split out from index.ts so it can be unit tested — index.ts
 * runs `main()` as a top-level side effect on import, which makes it unsafe to
 * import directly from a test.
 */

export interface ParsedArgs {
  flags: Map<string, string[]>;
  /** Every argument that wasn't consumed as a --flag or a flag's value, in
   *  order. For "run" this is unused (everything is a flag); for "do" this is
   *  where the sentence comes from, regardless of whether flags appear before,
   *  after, or interspersed with it — `do --repo X "add test.md"` and
   *  `do "add test.md" --repo X` must both work, since there's no reason to
   *  expect a user to put flags in one particular position. */
  positional: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      flags.set(name, [...(flags.get(name) ?? []), "true"]);
      continue;
    }
    flags.set(name, [...(flags.get(name) ?? []), value]);
    i++;
  }
  return { flags, positional };
}

export function parseCheck(spec: string): AcceptanceCheck {
  const eq = spec.indexOf("=");
  const label = eq > 0 ? spec.slice(0, eq) : spec;
  const command = eq > 0 ? spec.slice(eq + 1) : spec;
  return { label, command, expectExitCode: 0, timeoutMs: 10 * 60_000 };
}

/** Common run-shaping flags, shared by "run" and as overrides on "do". */
export function readRunOptions(flags: Map<string, string[]>) {
  const onFailure = flags.get("on-failure")?.[0] ?? "escalate";
  if (!VALID_ON_FAILURE.has(onFailure)) {
    throw new Error(`--on-failure must be one of escalate|abandon|skip, got "${onFailure}"`);
  }

  return {
    model: flags.get("model")?.[0] ?? "claude-sonnet-5",
    // Real runs averaged 10.3 turns / 100s for one-line-file tasks, mostly
    // orientation rather than thinking — "high" was overkill for the
    // straightforward end of the workload. Still fully overridable per task.
    effort: (flags.get("effort")?.[0] ?? "medium") as EffortLevel,
    baseRef: flags.get("base-ref")?.[0] ?? "HEAD",
    maxAttempts: Number(flags.get("max-attempts")?.[0] ?? "3"),
    maxTurns: Number(flags.get("max-turns")?.[0] ?? "30"),
    maxWallClockMs: Number(flags.get("max-wall-clock-min")?.[0] ?? "20") * 60_000,
    // What to do when a task exhausts its attempts and can't be recovered
    // mechanically: raise a decision (default, safest), fail the objective
    // outright, or tolerate it and continue without that task.
    onFailure: onFailure as ObjectiveOnFailure,
  };
}

/** Extract the "do" sentence from raw argv: whatever isn't a --flag or a flag's
 *  value, joined in original order. Returns undefined if nothing is left. */
export function extractSentence(positional: string[]): string | undefined {
  const joined = positional.join(" ").trim();
  return joined || undefined;
}
