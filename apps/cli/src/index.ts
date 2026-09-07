#!/usr/bin/env node
import type { AcceptanceCheck, EffortLevel } from "@exec/core";
import { printEvents } from "./events.js";
import { inferCheck } from "./infer.js";
import { resolveRepoFromText } from "./resolve-repo.js";
import { runObjective } from "./run.js";

const USAGE = `
exec-agent — supervise a single Claude Code worker on one task, end to end.

  exec-agent do "<what to do, in plain English>" [options]
  exec-agent run --repo <path> --intent "<what to do>" --check "<label>=<command>" [options]
  exec-agent events <objective-id>

"do" is the quick path: say what you want, name the repo somewhere in the
sentence (it's matched against git repos under ~/Desktop — set
EXEC_REPO_SEARCH_PATHS to add more places to look), and it infers a check where
it reasonably can ("add/create <file>" gets a real file-exists check; anything
else falls back to a weak "something changed" check and says so). Override any
of it with the same flags "run" takes.

  exec-agent do "add test.md in takil-workspace"
  exec-agent do "add a CONTRIBUTING.md" --repo ../some/repo
  exec-agent do "refactor the auth module in takil-workspace" --check "tests=npm test"

"run" is the explicit path — no inference, you state everything:

Options for "run" (and overrides for "do"):
  --repo <path>              Git repo to work in (required for "run")
  --intent "<text>"          What the worker should do and why (required for "run")
  --check "<label>=<cmd>"    Acceptance check; repeatable. The label is optional
                              ("npm test" works, defaults label to the command).
                              This is what the supervisor believes over the
                              worker's own claims — required for "run".
  --title "<text>"           Short title (defaults to the intent, truncated)
  --base-ref <ref>           Base ref for the worktree (default: HEAD)
  --model <name>             Model alias or full id (default: claude-sonnet-5)
  --effort <level>           low | medium | high | xhigh | max (default: high)
  --max-attempts <n>         Checkpoint-and-respawn budget (default: 3)
  --max-turns <n>            Turn budget per attempt (default: 30)
  --max-wall-clock-min <n>   Wall-clock budget per attempt, minutes (default: 20)

Example:
  exec-agent run \\
    --repo ./.scratch/demo-repo \\
    --intent "Add an isEven(n) function to math.mjs and export it, plus a test." \\
    --check "tests=node math.test.mjs"
`;

function parseArgs(argv: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const name = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      out.set(name, [...(out.get(name) ?? []), "true"]);
      continue;
    }
    out.set(name, [...(out.get(name) ?? []), value]);
    i++;
  }
  return out;
}

function parseCheck(spec: string): AcceptanceCheck {
  const eq = spec.indexOf("=");
  const label = eq > 0 ? spec.slice(0, eq) : spec;
  const command = eq > 0 ? spec.slice(eq + 1) : spec;
  return { label, command, expectExitCode: 0, timeoutMs: 10 * 60_000 };
}

/** Common run-shaping flags, shared by "run" and as overrides on "do". */
function readRunOptions(args: Map<string, string[]>) {
  return {
    model: args.get("model")?.[0] ?? "claude-sonnet-5",
    effort: (args.get("effort")?.[0] ?? "high") as EffortLevel,
    baseRef: args.get("base-ref")?.[0] ?? "HEAD",
    maxAttempts: Number(args.get("max-attempts")?.[0] ?? "3"),
    maxTurns: Number(args.get("max-turns")?.[0] ?? "30"),
    maxWallClockMs: Number(args.get("max-wall-clock-min")?.[0] ?? "20") * 60_000,
  };
}

async function runDo(sentence: string | undefined, rest: string[]): Promise<void> {
  if (!sentence) {
    console.error(USAGE);
    console.error('error: "do" needs a sentence, e.g. exec-agent do "add test.md in takil-workspace"\n');
    process.exitCode = 1;
    return;
  }

  const args = parseArgs(rest);
  let repoPath = args.get("repo")?.[0];

  if (!repoPath) {
    const resolved = resolveRepoFromText(sentence);
    if (resolved.match) {
      repoPath = resolved.match.path;
      console.log(`Resolved repo: ${resolved.match.name} (${resolved.match.path})`);
    } else if (resolved.ambiguous.length > 0) {
      console.error(
        `Multiple known repos match that sentence: ${resolved.ambiguous.map((c) => c.name).join(", ")}.\n` +
          `Say which one with --repo, e.g. --repo "${resolved.ambiguous[0]!.path}"`,
      );
      process.exitCode = 1;
      return;
    } else {
      const known = resolved.known.map((c) => c.name).join(", ") || "(none found)";
      console.error(
        `Couldn't find a repo mentioned in that sentence under the search path.\n` +
          `Known repos: ${known}\n` +
          `Pass --repo explicitly, or set EXEC_REPO_SEARCH_PATHS to widen the search.`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const explicitChecks = args.get("check") ?? [];
  let checks: AcceptanceCheck[];
  if (explicitChecks.length > 0) {
    checks = explicitChecks.map(parseCheck);
  } else {
    const inferred = inferCheck(sentence);
    checks = [inferred.check];
    if (!inferred.specific) {
      console.log(
        `No specific check could be inferred — falling back to "${inferred.check.command}" ` +
          `(only proves something changed, not that it's correct). Pass --check for a real gate.`,
      );
    } else {
      console.log(`Inferred check: ${inferred.check.label} -> ${inferred.check.command}`);
    }
  }

  const title = args.get("title")?.[0] ?? sentence.slice(0, 72);
  const opts = readRunOptions(args);

  await runObjective({
    repoPath,
    baseRef: opts.baseRef,
    title,
    intent: sentence,
    checks,
    model: opts.model,
    effort: opts.effort,
    maxAttempts: opts.maxAttempts,
    maxTurns: opts.maxTurns,
    maxWallClockMs: opts.maxWallClockMs,
  });
}

async function runRun(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const repoPath = args.get("repo")?.[0];
  const intent = args.get("intent")?.[0];
  const checkSpecs = args.get("check") ?? [];

  if (!repoPath || !intent || checkSpecs.length === 0) {
    console.error(USAGE);
    console.error("error: --repo, --intent and at least one --check are required.\n");
    process.exitCode = 1;
    return;
  }

  const title = args.get("title")?.[0] ?? intent.slice(0, 72);
  const opts = readRunOptions(args);

  await runObjective({
    repoPath,
    baseRef: opts.baseRef,
    title,
    intent,
    checks: checkSpecs.map(parseCheck),
    model: opts.model,
    effort: opts.effort,
    maxAttempts: opts.maxAttempts,
    maxTurns: opts.maxTurns,
    maxWallClockMs: opts.maxWallClockMs,
  });
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "events") {
    const objectiveId = rest[0];
    if (!objectiveId) {
      console.error("usage: exec-agent events <objective-id>");
      process.exitCode = 1;
      return;
    }
    printEvents(objectiveId);
    return;
  }

  if (command === "do") {
    await runDo(rest[0], rest.slice(1));
    return;
  }

  if (command === "run") {
    await runRun(rest);
    return;
  }

  console.error(USAGE);
  process.exitCode = command ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
