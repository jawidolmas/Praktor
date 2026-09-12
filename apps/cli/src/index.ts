#!/usr/bin/env node
import { answerDecision, cancelObjective, openDb, runMigrations } from "@exec/db";
import { approveObjective } from "./approve.js";
import { parseArgs, parseCheck, readRunOptions } from "./args.js";
import {
  AUTOSTART_MODE_EXPLANATIONS,
  autostartStatus,
  installAutostart,
  uninstallAutostart,
} from "./autostart.js";
import { daemonStatus, ensureDaemonRunning, stopDaemon } from "./daemon-client.js";
import { printEvents } from "./events.js";
import { inferCheck } from "./infer.js";
import { resolveRepoFromText } from "./resolve-repo.js";
import { submitAndWatch, tailObjective } from "./run.js";

const USAGE = `
exec-agent — supervise a single Claude Code worker on one task, end to end.

  exec-agent do "<what to do, in plain English>" [options]
  exec-agent run --repo <path> --intent "<what to do>" --check "<label>=<command>" [options]
  exec-agent watch <objective-id>
  exec-agent events <objective-id>
  exec-agent decide <decision-key> <option-id> [--by "<name>"]
  exec-agent approve <objective-id>
  exec-agent abandon <objective-id>
  exec-agent daemon start|stop|status
  exec-agent daemon install-autostart --mode logon|boot
  exec-agent daemon uninstall-autostart

"do" is the quick path: say what you want, name the repo somewhere in the
sentence (it's matched against git repos under ~/Desktop — set
EXEC_REPO_SEARCH_PATHS to add more places to look). If it's obviously a single
step ("add/create <file>" gets a real file-exists check), that's all that
happens. Otherwise the supervisor daemon breaks it into a dependency-ordered
task graph before starting, instead of guessing at a check for a sentence too
open-ended to infer one from. Flags can go anywhere — before the sentence,
after it, or both. Override any of it with the same flags "run" takes.

  exec-agent do "add test.md in my-project"
  exec-agent do --repo ../some/repo "add a CONTRIBUTING.md"
  exec-agent do "refactor the auth module in my-project" --check "tests=npm test"

Both "do" and "run" submit the objective to the supervisor daemon (starting
one if none is running yet) and then watch it happen — the same live output
as before. Ctrl-C stops watching, not the objective: it keeps running in the
daemon regardless, and you can reattach any time with "watch".

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
  --effort <level>           low | medium | high | xhigh | max (default: medium)
  --max-attempts <n>         Checkpoint-and-respawn budget (default: 3)
  --max-turns <n>            Turn budget per attempt (default: 30)
  --max-wall-clock-min <n>   Wall-clock budget per attempt, minutes (default: 20)
  --on-failure <policy>      escalate | abandon | skip — what to do when a task exhausts
                              its attempts and can't be recovered (default: escalate).
                              "escalate" raises a decision instead of giving up silently;
                              "abandon" fails the whole objective; "skip" tolerates that
                              one task's failure (and drops whatever depended on it) and
                              lets the rest of the objective still finish.

"daemon start" launches the supervisor as a detached background process (it
survives this terminal closing); "do"/"run" also do this automatically, so
you rarely need it directly. "daemon stop" asks it to exit — any task it was
mid-attempt on resumes from its last completed attempt next time a daemon
starts. "daemon status" reports whether one is running, its pid, and whether
autostart is registered.

Surviving the terminal closing isn't the same as surviving the machine
rebooting — "daemon install-autostart" registers a scheduled task so the
daemon comes back on its own. "--mode logon" starts it next time you log in
(no special privileges needed); "--mode boot" starts it as Windows comes up,
before anyone logs in (needs an elevated/Administrator terminal to register).
Re-running it with a different --mode switches which one is registered.
"daemon uninstall-autostart" removes it.

"decide" answers an open decision from any terminal, not necessarily the one
watching the objective — useful once you've walked away. The dashboard can
also answer decisions. Omitting --by records "cli-operator".

"approve" is the human checkpoint before anything reaches your real repo: a
worker's work always lands on its own branch, never merged automatically.
This shows you the diff, and on "y" merges that branch into your repo's real
base branch and pushes it. The dashboard has the same thing as a button.

"abandon" is the explicit "call it off" — an objective otherwise stays the
daemon's responsibility until it's done, failed, or a decision resolves it.
Any task not already finished is marked abandoned rather than deleted, so
what was tried survives in the event log. A task genuinely running right now
finishes its current attempt regardless; nothing new is started after.

Example:
  exec-agent run \\
    --repo ./.scratch/demo-repo \\
    --intent "Add an isEven(n) function to math.mjs and export it, plus a test." \\
    --check "tests=node math.test.mjs"
`;

async function runDo(argv: string[]): Promise<void> {
  const { flags, positional } = parseArgs(argv);
  // Flags can appear before, after, or around the sentence — join whatever
  // positional text is left over, in its original order, rather than requiring
  // it to be argv[0].
  const sentence = positional.join(" ").trim() || undefined;

  if (!sentence) {
    console.error(USAGE);
    console.error(
      'error: "do" needs a sentence, e.g. exec-agent do "add test.md in my-project"\n',
    );
    process.exitCode = 1;
    return;
  }

  let repoPath = flags.get("repo")?.[0];

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

  const explicitChecks = flags.get("check") ?? [];
  const title = flags.get("title")?.[0] ?? sentence.slice(0, 72);
  const opts = readRunOptions(flags);
  const common = {
    repoPath,
    baseRef: opts.baseRef,
    title,
    intent: sentence,
    model: opts.model,
    effort: opts.effort,
    maxAttempts: opts.maxAttempts,
    maxTurns: opts.maxTurns,
    maxWallClockMs: opts.maxWallClockMs,
    onFailure: opts.onFailure,
  };

  // A check you stated yourself always wins — you've already told us how to
  // verify it, so there's nothing left to plan.
  if (explicitChecks.length > 0) {
    await submitAndWatch({ mode: "direct", ...common, checks: explicitChecks.map(parseCheck) });
    return;
  }

  const inferred = inferCheck(sentence, repoPath);
  if (inferred.collisionWarning) {
    console.log(`Note: ${inferred.collisionWarning}`);
  }

  if (inferred.specific) {
    console.log(`Inferred check: ${inferred.check.label} -> ${inferred.check.command}`);
    await submitAndWatch({ mode: "direct", ...common, checks: [inferred.check] });
    return;
  }

  console.log(
    "Nothing simple enough to check directly — the supervisor daemon will break this " +
      "down into a task graph before starting.",
  );
  await submitAndWatch({ mode: "plan", ...common });
}

async function runRun(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  const repoPath = flags.get("repo")?.[0];
  const intent = flags.get("intent")?.[0];
  const checkSpecs = flags.get("check") ?? [];

  if (!repoPath || !intent || checkSpecs.length === 0) {
    console.error(USAGE);
    console.error("error: --repo, --intent and at least one --check are required.\n");
    process.exitCode = 1;
    return;
  }

  const title = flags.get("title")?.[0] ?? intent.slice(0, 72);
  const opts = readRunOptions(flags);

  await submitAndWatch({
    mode: "direct",
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
    onFailure: opts.onFailure,
  });
}

async function runWatch(argv: string[]): Promise<void> {
  const objectiveId = argv[0];
  if (!objectiveId) {
    console.error("usage: exec-agent watch <objective-id>");
    process.exitCode = 1;
    return;
  }
  const { db } = openDb();
  runMigrations(db);
  const daemon = await ensureDaemonRunning();
  if (daemon.started) {
    console.log(`Started the supervisor daemon (pid ${daemon.pid}) — nothing was progressing until now.`);
  }
  await tailObjective(db, objectiveId);
}

async function runDecide(argv: string[]): Promise<void> {
  const { flags, positional } = parseArgs(argv);
  const key = positional[0];
  const answer = positional[1];
  if (!key || !answer) {
    console.error('usage: exec-agent decide <decision-key> <option-id> [--by "<name>"]');
    process.exitCode = 1;
    return;
  }
  const answeredBy = flags.get("by")?.[0] ?? "cli-operator";

  const { db } = openDb();
  runMigrations(db);
  const applied = answerDecision(db, { key, answer, answeredBy });
  if (!applied) {
    console.error(`${key} is not an open decision (already answered, or no such key).`);
    process.exitCode = 1;
    return;
  }
  console.log(`${key} answered "${answer}" by ${answeredBy}.`);
}

async function runAbandon(argv: string[]): Promise<void> {
  const objectiveId = argv[0];
  if (!objectiveId) {
    console.error("usage: exec-agent abandon <objective-id>");
    process.exitCode = 1;
    return;
  }

  const { db } = openDb();
  runMigrations(db);
  const cancelled = cancelObjective(db, objectiveId);
  if (!cancelled) {
    console.error(`${objectiveId} is not an open objective (already finished, or no such id).`);
    process.exitCode = 1;
    return;
  }
  console.log(`${objectiveId} abandoned. Anything not already finished is marked abandoned.`);
}

async function runDaemon(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub === "start") {
    const result = await ensureDaemonRunning();
    console.log(
      result.started
        ? `Started the supervisor daemon (pid ${result.pid}).`
        : `Already running (pid ${result.pid}).`,
    );
    return;
  }
  if (sub === "stop") {
    const result = await stopDaemon();
    if (!result.stopped) {
      console.log("No daemon is running.");
    } else if (result.confirmed) {
      console.log(`Stopped the supervisor daemon (pid ${result.pid}).`);
    } else {
      console.error(
        `Sent a stop signal to the supervisor daemon (pid ${result.pid}), but it had not exited ` +
          `after 5s. Check "exec-agent daemon status" before starting a new one — starting one ` +
          `while the old one is still alive risks two daemons driving the same tasks at once.`,
      );
      process.exitCode = 1;
    }
    return;
  }
  if (sub === "status") {
    const status = daemonStatus();
    console.log(status.running ? `Running (pid ${status.pid}).` : "Not running.");
    const auto = autostartStatus();
    console.log(
      auto.installed
        ? `Autostart: registered (${auto.mode ?? "unrecognized trigger"}).`
        : "Autostart: not installed — the daemon will not come back after a reboot. Set it up " +
          "with: exec-agent daemon install-autostart --mode logon|boot",
    );
    return;
  }
  if (sub === "install-autostart") {
    const { flags } = parseArgs(argv.slice(1));
    const mode = flags.get("mode")?.[0];
    if (mode !== "logon" && mode !== "boot") {
      console.log("Choose how the daemon should start on its own:\n");
      console.log(`  logon   ${AUTOSTART_MODE_EXPLANATIONS.logon}`);
      console.log(`  boot    ${AUTOSTART_MODE_EXPLANATIONS.boot}\n`);
      console.log("exec-agent daemon install-autostart --mode logon|boot");
      process.exitCode = 1;
      return;
    }
    const result = installAutostart(mode);
    console.log(result.message);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (sub === "uninstall-autostart") {
    const result = uninstallAutostart();
    console.log(result.message);
    return;
  }
  console.error("usage: exec-agent daemon start|stop|status|install-autostart|uninstall-autostart");
  process.exitCode = 1;
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
    await runDo(rest);
    return;
  }

  if (command === "run") {
    await runRun(rest);
    return;
  }

  if (command === "watch") {
    await runWatch(rest);
    return;
  }

  if (command === "decide") {
    await runDecide(rest);
    return;
  }

  if (command === "daemon") {
    await runDaemon(rest);
    return;
  }

  if (command === "approve") {
    const objectiveId = rest[0];
    if (!objectiveId) {
      console.error("usage: exec-agent approve <objective-id>");
      process.exitCode = 1;
      return;
    }
    await approveObjective(objectiveId);
    return;
  }

  if (command === "abandon") {
    await runAbandon(rest);
    return;
  }

  console.error(USAGE);
  process.exitCode = command ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
