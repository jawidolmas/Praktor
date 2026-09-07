#!/usr/bin/env node
import type { AcceptanceCheck, EffortLevel } from "@exec/core";
import { printEvents } from "./events.js";
import { runObjective } from "./run.js";

const USAGE = `
exec — supervise a single Claude Code worker on one task, end to end.

  exec run --repo <path> --intent "<what to do>" --check "<label>=<command>" [options]
  exec events <objective-id>

Options for "run":
  --repo <path>              Git repo to work in (required)
  --intent "<text>"          What the worker should do and why (required)
  --check "<label>=<cmd>"    Acceptance check; repeatable. The label is optional
                              ("npm test" works, defaults label to the command).
                              At least one is required — this is what the
                              supervisor believes over the worker's own claims.
  --title "<text>"           Short title (defaults to the intent, truncated)
  --base-ref <ref>           Base ref for the worktree (default: HEAD)
  --model <name>             Model alias or full id (default: claude-sonnet-5)
  --effort <level>           low | medium | high | xhigh | max (default: high)
  --max-attempts <n>         Checkpoint-and-respawn budget (default: 3)
  --max-turns <n>            Turn budget per attempt (default: 30)
  --max-wall-clock-min <n>   Wall-clock budget per attempt, minutes (default: 20)

Example:
  npm run exec -- run \\
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

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "events") {
    const objectiveId = rest[0];
    if (!objectiveId) {
      console.error("usage: exec events <objective-id>");
      process.exitCode = 1;
      return;
    }
    printEvents(objectiveId);
    return;
  }

  if (command === "run") {
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
    const model = args.get("model")?.[0] ?? "claude-sonnet-5";
    const effort = (args.get("effort")?.[0] ?? "high") as EffortLevel;
    const baseRef = args.get("base-ref")?.[0] ?? "HEAD";
    const maxAttempts = Number(args.get("max-attempts")?.[0] ?? "3");
    const maxTurns = Number(args.get("max-turns")?.[0] ?? "30");
    const maxWallClockMin = Number(args.get("max-wall-clock-min")?.[0] ?? "20");

    await runObjective({
      repoPath,
      baseRef,
      title,
      intent,
      checks: checkSpecs.map(parseCheck),
      model,
      effort,
      maxAttempts,
      maxTurns,
      maxWallClockMs: maxWallClockMin * 60_000,
    });
    return;
  }

  console.error(USAGE);
  process.exitCode = command ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
