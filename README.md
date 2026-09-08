# exec-agent

A supervisor for Claude Code. You give it an objective in plain English; it opens an isolated
git worktree, drives a Claude Code worker inside it, enforces a set of hard rules the worker
cannot talk its way around, verifies the result by actually running a command rather than
trusting the worker's own "done" — and hands you back a report and a branch to review.

It is not another coding agent. It's the layer above one: deterministic code makes every
control-flow decision (spawn, verify, retry, deny), and the model is only ever asked to do the
coding itself.

## Status

This is v0.1: **one task per objective**, run in the foreground, start to finish. There is no
multi-task decomposition, no daemon, and no Telegram bridge yet — `apps/daemon` and
`apps/telegram` are reserved directories for that, not built out. What exists today:

- Plain-English intake (`exec-agent do "..."`) that resolves the target repo and infers a
  pass/fail check where it reasonably can.
- Worker isolation via a dedicated `git worktree` and branch per attempt — nothing runs against
  your working tree directly.
- A policy engine that denies or asks about dangerous actions (force-push, push to `main`,
  production deploys, destructive SQL, committing secrets) via Claude Code's own `PreToolUse`
  hook — enforced by the harness, not by asking the model nicely.
- A verification gate: the supervisor runs your acceptance command itself and only accepts the
  work if that command actually passes.
- Checkpoint-and-respawn on failure: a fresh worker session is seeded with what was tried and
  ruled out, instead of endlessly retrying the same dead end in one long context.
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
git clone https://github.com/<you>/exec-agent.git
cd exec-agent
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
storage layer, policy engine, and Claude Code driver respectively; `apps/cli` is the only
consumer today.

## License

MIT — see [LICENSE](LICENSE).
