import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { newId, newSessionId, type EffortLevel, type TokenUsage } from "@exec/core";
import {
  activePolicies,
  addRuledOut,
  answerDecision,
  appendEvent,
  decisions,
  nextDecisionKey,
  runs,
  setObjectiveStatus,
  setTaskStatus,
  tasks,
  writeArtifact,
  type Db,
  type ObjectiveRow,
  type TaskRow,
} from "@exec/db";
import {
  buildCheckpoint,
  churn,
  commitAll,
  createWorktree,
  removeWorktree,
  renderCheckpointNote,
  runAcceptance,
  runWorker,
  type RunWorkerResult,
  type VerifyOutcome,
  type WorktreeHandle,
} from "@exec/worker";
import { renderReport, type AttemptSummary } from "./report.js";

/**
 * The task-execution engine — extracted, unchanged in substance, from what
 * used to be the CLI's own `runObjective` loop. The difference is who calls
 * it and how long it can wait: the daemon drives a task purely from its
 * database row (there is no CLI process left holding args in memory by the
 * time this runs), and a rate limit now means "wait and keep going" instead
 * of "give up," because giving up is the one thing "tell it and go chill"
 * cannot tolerate.
 */

const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

const RATE_LIMIT_NOTE =
  "The previous session for this attempt was paused by a rate limit, not by a " +
  "mistake — the repository already reflects whatever progress had been made. " +
  "Inspect the current state and continue from there; do not restart from scratch.";

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Rate limits report their own reset time; clamp it into a sane retry window
 * so a bad or absent hint can't make the daemon either hammer the API or go
 * quiet for an unreasonable stretch before checking again.
 */
export function clampParkDelay(retryDelayMs: number | undefined): number {
  const MIN_MS = 30_000;
  const MAX_MS = 30 * 60_000;
  const DEFAULT_MS = 60_000;
  if (retryDelayMs === undefined || !Number.isFinite(retryDelayMs)) return DEFAULT_MS;
  return Math.min(MAX_MS, Math.max(MIN_MS, retryDelayMs));
}

const DECISION_POLL_MS = 3000;

/** Blocks until someone — a terminal watching this objective, the dashboard,
 *  or `exec-agent decide` — answers the decision. There is deliberately no
 *  timeout: a decision the daemon gave up on by itself is not a decision. */
async function waitForDecision(db: Db, key: string): Promise<{ answer: string; answeredBy: string }> {
  for (;;) {
    const row = db.select().from(decisions).where(eq(decisions.key, key)).get();
    if (row?.status === "answered" && row.answer && row.answeredBy) {
      return { answer: row.answer, answeredBy: row.answeredBy };
    }
    await sleep(DECISION_POLL_MS);
  }
}

function worktreePathFor(taskId: string, attempt: number): string {
  return resolve(
    process.env["EXEC_WORKTREES_DIR"] ?? join(homedir(), ".exec-agent", "worktrees"),
    `${taskId}-${attempt}`,
  );
}

interface AttemptOutcome {
  worktree: WorktreeHandle;
  runId: string;
  result: RunWorkerResult;
}

/**
 * Drive one attempt slot to a conclusion other than a rate limit. Internally
 * this may call the worker more than once — every rate-limited retry reuses
 * the same worktree (nothing is thrown away) and does not consume the task's
 * attempt budget, only wall-clock time.
 */
async function runAttempt(
  db: Db,
  task: TaskRow,
  objective: ObjectiveRow,
  attempt: number,
  ruledOut: string[],
  initialNote: string | undefined,
): Promise<AttemptOutcome> {
  const branch = `exec/${task.id.slice(0, 8)}-attempt-${attempt}`;
  const worktreePath = worktreePathFor(task.id, attempt);
  const worktree = createWorktree({
    repoPath: objective.repoPath,
    worktreePath,
    branch,
    baseRef: objective.baseRef,
  });

  let note = initialNote;

  for (;;) {
    const objectivePolicies = activePolicies(db, objective.id);
    const runId = newId();
    const sessionId = newSessionId();

    db.insert(runs)
      .values({
        id: runId,
        taskId: task.id,
        objectiveId: objective.id,
        attempt,
        sessionId,
        model: task.model,
        effort: task.effort,
        worktreePath,
        status: "running",
        turns: 0,
        usage: ZERO_USAGE,
        costUsdEstimate: 0,
        startedAt: Date.now(),
      })
      .run();
    appendEvent(db, {
      objectiveId: objective.id,
      taskId: task.id,
      runId,
      payload: {
        type: "run.started",
        sessionId,
        model: task.model,
        worktreePath,
        attempt,
        seededFromCheckpoint: note !== undefined,
      },
    });

    let lastRateLimitDelayMs: number | undefined;

    const result = await runWorker({
      sessionId,
      cwd: worktreePath,
      model: task.model,
      effort: task.effort as EffortLevel,
      budget: task.budget,
      prompt: {
        intent: task.intent,
        ruledOut,
        ...(note !== undefined ? { checkpointNote: note } : {}),
      },
      policies: objectivePolicies,
      onEvent: (payload) => {
        appendEvent(db, { objectiveId: objective.id, taskId: task.id, runId, payload });
        if (payload.type === "ratelimit.hit") lastRateLimitDelayMs = payload.retryDelayMs;
      },
      supervisorCallbacks: {
        requestDecision: async (input) => {
          const decisionKeyValue = nextDecisionKey(db);
          db.insert(decisions)
            .values({
              id: newId(),
              key: decisionKeyValue,
              objectiveId: objective.id,
              taskId: task.id,
              runId,
              level: "L2",
              title: input.title,
              context: input.context,
              options: input.options,
              recommendation: input.recommendation,
              risk: input.risk,
              blockedTaskIds: [task.id],
              status: "open",
              createdAt: Date.now(),
            })
            .run();
          appendEvent(db, {
            objectiveId: objective.id,
            taskId: task.id,
            runId,
            payload: {
              type: "decision.raised",
              key: decisionKeyValue,
              level: "L2",
              title: input.title,
              blockedTaskIds: [task.id],
            },
          });
          setTaskStatus(db, task.id, "blocked");
          setObjectiveStatus(db, objective.id, "blocked");
          console.log(`[${objective.id.slice(0, 8)}] decision needed: ${decisionKeyValue} — ${input.title}`);

          const answered = await waitForDecision(db, decisionKeyValue);

          setTaskStatus(db, task.id, "running");
          setObjectiveStatus(db, objective.id, "active");
          return answered;
        },
        reportProgress: (input) => {
          appendEvent(db, {
            objectiveId: objective.id,
            taskId: task.id,
            runId,
            payload: { type: "run.progress", milestone: input.milestone, detail: input.detail },
          });
        },
        recordFinding: (input) => {
          appendEvent(db, {
            objectiveId: objective.id,
            taskId: task.id,
            runId,
            payload: { type: "finding.recorded", title: input.title, detail: input.detail },
          });
        },
        loadPolicies: () => objectivePolicies,
      },
    });

    db.update(runs)
      .set({
        status: "finished",
        exitReason: result.exitReason,
        turns: result.turns,
        usage: result.usage,
        costUsdEstimate: result.costUsdEstimate,
        endedAt: Date.now(),
      })
      .where(eq(runs.id, runId))
      .run();
    console.log(
      `[${objective.id.slice(0, 8)}] attempt ${attempt} run finished: ${result.exitReason} (${result.turns} turns, $${result.costUsdEstimate.toFixed(4)} est.)`,
    );

    if (result.exitReason !== "rate_limited") {
      return { worktree, runId, result };
    }

    setTaskStatus(db, task.id, "parked");
    setObjectiveStatus(db, objective.id, "parked");
    const delay = clampParkDelay(lastRateLimitDelayMs);
    console.log(`[${objective.id.slice(0, 8)}] rate limited — retrying attempt ${attempt} in ${Math.round(delay / 1000)}s`);
    await sleep(delay);
    setTaskStatus(db, task.id, "running");
    setObjectiveStatus(db, objective.id, "active");
    note = note ? `${note}\n\n${RATE_LIMIT_NOTE}` : RATE_LIMIT_NOTE;
  }
}

export type DriveResult = "done" | "failed";

/** Drive one task through its remaining attempt budget: worktree -> worker ->
 *  verify -> commit, with a mechanical checkpoint-and-respawn loop on
 *  failure — the whole supervisor loop, same as before, just resumable from
 *  the database at `task.attempts` instead of always starting at 1. */
export async function driveTask(db: Db, task: TaskRow, objective: ObjectiveRow): Promise<DriveResult> {
  setTaskStatus(db, task.id, "running");
  setObjectiveStatus(db, objective.id, "active");

  const attempts: AttemptSummary[] = [];
  let ruledOut = [...task.ruledOut];
  let checkpointNote: string | undefined;
  let finalStatus: DriveResult = "failed";
  let committed = false;
  let lastWorktree: WorktreeHandle | undefined;

  for (let attempt = task.attempts + 1; attempt <= task.maxAttempts; attempt++) {
    console.log(`[${objective.id.slice(0, 8)}] attempt ${attempt}/${task.maxAttempts} starting`);

    const { worktree, runId, result } = await runAttempt(db, task, objective, attempt, ruledOut, checkpointNote);
    lastWorktree = worktree;

    // Persisted only once the attempt has a real, concluded outcome — not
    // when it starts. A task can sit "blocked" on a decision, or "running",
    // across a daemon restart (recoverOrphans requeues "running" but leaves
    // "blocked" alone, since that's valid regardless of daemon liveness);
    // either way the original attempt's session is gone and whatever
    // eventually resumes it is a fresh one. Counting the attempt only now
    // means a restart never charges the task for an attempt that never
    // actually concluded — recording it eagerly at the top of the loop was
    // found, by testing this exact restart-while-blocked path, to silently
    // exhaust the attempt budget with zero real attempts made whenever the
    // interrupted one happened to be the last one allowed.
    db.update(tasks).set({ attempts: attempt, updatedAt: Date.now() }).where(eq(tasks.id, task.id)).run();

    let verify: VerifyOutcome | undefined;
    if (result.exitReason === "completed") {
      verify = runAcceptance(worktree.path, task.acceptance);
      for (const check of verify.checks) {
        appendEvent(db, {
          objectiveId: objective.id,
          taskId: task.id,
          runId,
          payload: {
            type: "verify.check",
            label: check.label,
            command: check.command,
            exitCode: check.exitCode ?? -1,
            passed: check.passed,
            durationMs: check.durationMs,
          },
        });
      }
      appendEvent(db, {
        objectiveId: objective.id,
        taskId: task.id,
        runId,
        payload: {
          type: "verify.result",
          passed: verify.passed,
          failedLabels: verify.checks.filter((c) => !c.passed).map((c) => c.label),
        },
      });
    }

    attempts.push({
      attempt,
      exitReason: result.exitReason,
      turns: result.turns,
      usage: result.usage,
      costUsdEstimate: result.costUsdEstimate,
      ...(verify !== undefined ? { verify } : {}),
    });

    if (verify?.passed) {
      committed = commitAll(worktree.path, `${task.title}\n\n${result.resultText ?? ""}`.trim());
      finalStatus = "done";
      setTaskStatus(db, task.id, "done");
      break;
    }

    const changed = churn(worktree.path);
    const checkpoint = buildCheckpoint({
      taskTitle: task.title,
      intent: task.intent,
      filesChanged: changed.filesChanged,
      ruledOut,
      ...(result.stallSignal !== undefined ? { stallSignal: result.stallSignal } : {}),
      ...(verify !== undefined ? { verify } : {}),
      ...(result.resultText !== undefined ? { resultText: result.resultText } : {}),
    });
    const artifactId = writeArtifact(db, {
      kind: "checkpoint",
      content: checkpoint,
      objectiveId: objective.id,
      taskId: task.id,
      runId,
    });
    appendEvent(db, {
      objectiveId: objective.id,
      taskId: task.id,
      runId,
      payload: { type: "checkpoint.written", artifactId, ruledOutCount: checkpoint.doNotRepeat.length },
    });
    addRuledOut(db, task.id, checkpoint.doNotRepeat);
    ruledOut = [...ruledOut, ...checkpoint.doNotRepeat];
    checkpointNote = renderCheckpointNote(checkpoint);

    removeWorktree(worktree);

    if (attempt === task.maxAttempts) {
      setTaskStatus(db, task.id, "failed");
    }
  }

  setObjectiveStatus(db, objective.id, finalStatus);

  const report = renderReport({
    taskTitle: task.title,
    intent: task.intent,
    attempts,
    finalStatus,
    branch: lastWorktree?.branch ?? "-",
    worktreePath: lastWorktree?.path ?? "-",
    committed,
  });
  writeArtifact(db, { kind: "report", content: report, objectiveId: objective.id, taskId: task.id });

  return finalStatus;
}
