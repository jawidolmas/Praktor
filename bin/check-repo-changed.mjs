#!/usr/bin/env node
import { execSync } from "node:child_process";

/**
 * Exit 0 if the repo has moved since the attempt started, 1 if nothing did.
 *
 * The generic "something changed" fallback acceptance check, for a request the
 * infer heuristic couldn't turn into a specific file check.
 *
 * Two things count as "moved," because a task can be satisfied either way:
 *   - The working tree is dirty (`git status --porcelain` non-empty) — the
 *     normal shape, where the worker edits files and leaves them for the
 *     supervisor's own commit afterward.
 *   - HEAD has moved past $EXEC_BASE_SHA — the worker committed (and maybe
 *     pushed) itself, e.g. a "commit and push" request, or one that hit a
 *     policy like "no direct push to main" and correctly pushed a branch
 *     instead. A commit-and-push that succeeds leaves a *clean* tree, which
 *     is exactly the case the old dirty-only check got backwards: it read a
 *     worker that did the task correctly, including respecting a policy
 *     denial, as "FAILED — nothing happened."
 *
 * $EXEC_BASE_SHA is set by the daemon to the attempt's own starting commit
 * (see worktree.ts's `baseSha`) — not a fixed ref name, since "HEAD" means a
 * different commit in every worktree that evaluates it. If it's unset (a
 * user-supplied `--check` invoking this script directly, outside the
 * daemon), only the dirty-tree half applies.
 */
// This script itself runs with no console of its own (spawned by the
// daemon, which has none either) — without windowsHide, each of these would
// pop up its own fresh, visible console window on Windows.
function isDirty() {
  try {
    return execSync("git status --porcelain", { encoding: "utf8", windowsHide: true }).trim().length > 0;
  } catch {
    return false;
  }
}

function headMovedPastBase(baseSha) {
  if (!baseSha) return false;
  try {
    const head = execSync("git rev-parse HEAD", { encoding: "utf8", windowsHide: true }).trim();
    return head !== baseSha;
  } catch {
    return false;
  }
}

const changed = isDirty() || headMovedPastBase(process.env.EXEC_BASE_SHA);
process.exit(changed ? 0 : 1);
