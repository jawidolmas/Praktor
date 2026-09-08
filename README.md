# Praktor

A supervisor for Claude Code. Installs as the `exec-agent` command. You give it an objective in plain English; it opens an isolated
git worktree, drives a Claude Code worker inside it, enforces a set of hard rules the worker
cannot talk its way around, verifies the result by actually running a command rather than
trusting the worker's own "done" — and hands you back a report and a branch to review.

It is not another coding agent. It's the layer above one: deterministic code makes every
control-flow decision (spawn, verify, retry, deny), and the model is only ever asked to do the
coding itself.

## Status

This is v0.1: **one task per objective**. There is no multi-task decomposition and no Telegram
bridge yet — `apps/telegram` is a reserved directory for that, not built out. What exists today:

- Plain-English intake (`exec-agent do "..."`) that resolves the target repo and infers a
  pass/fail check where it reasonably can.
- A persistent supervisor **daemon**: `do`/`run` submit an objective and return immediately —
  the daemon (started automatically if none is running) is what actually drives it, so closing
  the terminal, or the whole laptop, does not stop the work. Reattach any time with
  `exec-agent watch <objective-id>`.
- Worker isolation via a dedicated `git worktree` and branch per attempt — nothing runs against
  your working tree directly.
- A policy engine that denies or asks about dangerous actions (force-push, push to `main`,
  production deploys, destructive SQL, committing secrets) via Claude Code's own `PreToolUse`
  hook — enforced by the harness, not by asking the model nicely.
- A verification gate: the supervisor runs your acceptance command itself and only accepts the
  work if that command actually passes.
- Checkpoint-and-respawn on failure: a fresh worker session is seeded with what was tried and
  ruled out, instead of endlessly retrying the same dead end in one long context.
- Rate-limit park-and-resume: a rate limit pauses an attempt and retries it in place once it
  clears, instead of giving up — it does not consume the attempt budget.
- Decisions raised by a worker (`request_decision`) can be answered from wherever you actually
  are: the terminal watching it (same prompt as always), `exec-agent decide <key> <option>` from
  any other terminal, or a button in the dashboard.
- A full event log per objective (`exec-agent events <id>`) as the source of truth — never just
  the last thing printed to the terminal.

## Prerequisites

- **Node.js 20+**
- **git**
- The **Claude Code CLI**, installed and logged in (`claude` should already work in your
  terminal). exec-agent piggybacks on that login — it does not take an API key and does not
  bill separately. Every worker run draws from the same Claude Pro/Max usage pool as your normal
  Claude Code sessions, so heavy concurrent use of both will deplete your quota faster, but a
  given task does not cost double just because exec-agent is the one driving it.

## Install

```bash
git clone https://github.com/jawidolmas/Praktor.git
cd Praktor
npm install      # also builds the workspace packages (npm's "prepare" step)
npm link         # makes `exec-agent` available globally
```

`npm link` is what makes the `exec-agent` command resolve from any directory, not just this
repo's folder. If you ever see the CLI complain about a missing `dist/` file after pulling new
changes, run `npm run build`.

## Quickstart

The fast path — say what you want, name the repo somewhere in the sentence:

```bash
exec-agent do "add a CONTRIBUTING.md in my-project"
```

exec-agent looks for a git repo named `my-project` under `~/Desktop` by default (see
Configuration below to widen that search), infers a check appropriate to the request (a file-add
gets a real existence check; anything else falls back to a "something changed" check and tells
you so), and then runs the whole loop end to end.

The explicit path — state everything yourself, including a real acceptance command:

```bash
exec-agent run \
  --repo ./path/to/repo \
  --intent "Add an isEven(n) function to math.js and export it, plus a test." \
  --check "tests=node math.test.js"
```

`--check` is what the supervisor actually believes. Prefer a real test or build command over the
inferred "something changed" fallback whenever you can — the fallback proves the worker touched
the repo, not that it did the right thing.

Afterwards:

```bash
exec-agent events <objective-id>   # full event log for that run
```

Every run prints its objective id and the git branch (`exec/<id>-attempt-N`) the work landed on.
Nothing is ever merged automatically — review the branch and merge it yourself.

`do` and `run` both submit the objective to the supervisor daemon and then watch it live — same
output as always. **Ctrl-C stops watching, not the objective**: it keeps running in the daemon
regardless, and closing the terminal entirely has the same effect. Come back to it any time:

```bash
exec-agent watch <objective-id>      # reattach and watch live, from any terminal
exec-agent daemon status             # is a daemon running, and what's its pid
exec-agent daemon stop               # ask it to exit; work resumes from its last
                                      # completed attempt next time one starts
exec-agent decide <key> <option-id>  # answer an open decision from anywhere
```

## Daemon

The daemon is the process that actually drives objectives — `apps/cli` only ever inserts rows
and tails the event log. It is started automatically the first time you submit or watch
something; `exec-agent daemon start` exists for when you want it running ahead of time. It:

- Runs detached, so it survives the terminal (or the whole shell session) that started it.
- Picks up whatever's schedulable — including a task left `running` or `parked` by a previous
  daemon that crashed or was stopped — and resumes it from its last **completed** attempt. An
  attempt only counts once it actually concludes, so one interrupted mid-flight by a restart is
  retried, not skipped or silently charged against the budget.
- Parks a rate-limited attempt in place (same worktree, same progress) and retries it once the
  limit clears, instead of giving up. Time spent waiting on a rate limit, and time spent waiting
  on a decision, is never counted against the attempt's wall-clock budget — the whole point of
  "submit it and check back later" is that checking back later must not itself look like the
  worker stalling.
- Logs to `$EXEC_HOME/daemon.log`; single-instance-locked via `$EXEC_HOME/daemon.pid`.

## Dashboard

```bash
npm run dashboard
```

A local web view of the same database the daemon writes to — objectives, tasks, per-attempt runs
with token usage and cost, the active policy set, and a live-updating event log per objective (an
SSE stream, so you can watch a run happen from a browser instead of a terminal). It opens on
`http://127.0.0.1:4317` by default; override with `EXEC_WEB_PORT` / `EXEC_WEB_HOST`. Open
decisions can be answered right from a card here — each option's pros and cons are shown, same as
the terminal prompt — which lands the same `answerDecision` write the CLI's `decide` command
makes; SQLite's WAL mode is what lets this, the CLI, and the daemon all touch the database
concurrently without blocking each other.

## Configuration

All via environment variables (see `.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `EXEC_HOME` | `~/.exec-agent` | Supervisor's own state (SQLite db, checkpoints). Workers are policy-denied from writing here. |
| `EXEC_WORKTREES_DIR` | `~/.exec-agent/worktrees` | Where worker git worktrees are created. |
| `EXEC_REPO_SEARCH_PATHS` | *(unset)* | Extra directories `do` should search for repos, beyond `~/Desktop`. Comma- or semicolon-separated. |
| `EXEC_MAX_WORKERS` | `1` | Worker concurrency. Realistic value is 1 on a Pro plan; this build only ever runs one worker anyway (see Status). |

Run options (flags on `run`, and overrides on `do`): `--model`, `--effort`
(`low|medium|high|xhigh|max`, default `medium`), `--max-attempts`, `--max-turns`,
`--max-wall-clock-min`, `--base-ref`, `--title`. Run `exec-agent` with no arguments for the full
list.

## Policy engine

Six rules ship enabled by default (`packages/policy/src/seeds.ts`): no force-push or direct push
to a protected branch, no production deploys outside staging, destructive SQL requires a human
answer, secrets files can't be committed, the supervisor's own state can't be touched, and new
dependency installs are flagged in the report. They live in the database, not in a prompt — a
worker cannot reason its way past a `deny`, because the decision is made by a `PreToolUse` hook
before the tool call is ever allowed to run. Built-in policies are kept in sync with the code on
every run (matched by title), so a fix to a shipped policy reaches an install that's already been
running, not just fresh databases.

## Development

```bash
npm run typecheck   # tsc --build across the whole workspace
npm test            # vitest, full suite
```

`packages/core`, `packages/db`, `packages/policy`, and `packages/worker` hold the domain types,
storage layer, policy engine, and Claude Code driver respectively. `apps/cli` submits objectives
and tails their event log; `apps/daemon` is the only process that actually drives one; `apps/web`
is the dashboard.

## License

MIT — see [LICENSE](LICENSE).
