import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import {
  newId,
  newSessionId,
  taskKey,
  type AcceptanceCheck,
  type AcceptanceSpec,
  type Budget,
  type EffortLevel,
  type TokenUsage,
} from "@exec/core";
import {
  activePolicies,
  addRuledOut,
  answerDecision,
  appendEvent,
  decisions,
  nextDecisionKey,
  objectives,
  openDb,
  policies,
  runMigrations,
  runs,
  setTaskStatus,
  tasks,
  writeArtifact,
} from "@exec/db";
import {
  buildCheckpoint,
  churn,
  commitAll,
  createWorktree,
  formatLiveLine,
  removeWorktree,
  renderCheckpointNote,
  runAcceptance,
  runWorker,
  type VerifyOutcome,
  type WorktreeHandle,
} from "@exec/worker";
import { SEED_POLICIES } from "@exec/policy";
import { askInTerminal } from "./decide.js";
import { renderReport, type AttemptSummary } from "./report.js";

export interface RunObjectiveArgs {
  repoPath: string;
  baseRef: string;
  title: string;
  intent: string;
  checks: AcceptanceCheck[];
  model: string;
  effort: EffortLevel;
  maxAttempts: number;
  maxTurns: number;
  maxWallClockMs: number;
}

const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

/**
 * Keep the built-in policies in sync with the code, on every run — not just
 * once into an empty table.
 *
 * A one-time seed sounds right until the seed itself needs a fix: a real HARD
 * policy shipped with a pattern that silently failed to catch the exact thing
 * it was written for (git -C <path> push origin main slipping past a "push to
 * main" denial), and a table-is-empty-only seed means that fix would only ever
 * reach a brand-new database — every already-running install stays vulnerable
 * until someone deletes their database by hand. Built-in policies are matched
 * by title and brought back in line with the current code on every run;
 * anything whose title doesn't match a current built-in is left completely
 * alone (a genuinely custom policy, or one intentionally detached by renaming
 * it — there is no per-policy "don't sync me" flag yet, so renaming is the
 * only way to opt a built-in out of this today).
 */
export function reconcileSeedPolicies(db: ReturnType<typeof openDb>["db"]): void {
  const existing = db.select().from(policies).all();
  const byTitle = new Map(existing.map((p) => [p.title, p] as const));
  const now = Date.now();

  let updated = 0;
  for (const seed of SEED_POLICIES) {
    const row = byTitle.get(seed.title);
    if (!row) continue;
    const changed =
      JSON.stringify(row.matcher) !== JSON.stringify(seed.matcher) ||
      row.severity !== seed.severity ||
      row.action !== seed.action ||
      row.rationale !== seed.rationale;
    if (!changed) continue;
    db.update(policies)
      .set({
        matcher: seed.matcher,
        severity: seed.severity,
        action: seed.action,
        rationale: seed.rationale,
      })
      .where(eq(policies.id, row.id))
      .run();
    updated++;
  }
  if (updated > 0) {
    console.log(`Updated ${updated} built-in polic${updated === 1 ? "y" : "ies"} to the current definition.`);
  }

  const missing = SEED_POLICIES.filter((seed) => !byTitle.has(seed.title));
  if (missing.length === 0) return;
  let nextKeyNum = existing.length + 1;
  for (const seed of missing) {
    db.insert(policies)
      .values({
        id: newId(),
        key: `POLICY-${String(nextKeyNum++).padStart(3, "0")}`,
        ...seed,
        createdAt: now,
      })
      .run();
  }
  console.log(`Added ${missing.length} new built-in polic${missing.length === 1 ? "y" : "ies"}.`);
}

/**
 * Run a single task end to end: worktree -> worker -> verify -> commit, with a
 * mechanical checkpoint-and-respawn loop on failure. This is the whole supervisor
 * loop the design calls for, minus the DAG (one task), the brain (no LLM
 * decompose/review/diagnose calls yet), and the Telegram bridge (the terminal
 * plays that role for request_decision).
 */
export async function runObjective(args: RunObjectiveArgs): Promise<void> {
  const { db, path: dbPath } = openDb();
  runMigrations(db);
  reconcileSeedPolicies(db);

  const objectiveId = newId();
  const now = Date.now();
  const budget: Budget = {
    maxTurns: args.maxTurns,
    maxTokens: 400_000,
    maxWallClockMs: args.maxWallClockMs,
  };

  db.insert(objectives)
    .values({
      id: objectiveId,
      title: args.title,
      brief: args.intent,
      repoPath: args.repoPath,
      baseRef: args.baseRef,
      status: "active",
      budget,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  appendEvent(db, {
    objectiveId,
    payload: { type: "objective.created", title: args.title, repoPath: args.repoPath },
  });

  const taskId = newId();
  const key = taskKey(1);
  const acceptance: AcceptanceSpec = { checks: args.checks };

  db.insert(tasks)
    .values({
      id: taskId,
      objectiveId,
      key,
      title: args.title,
      intent: args.intent,
      taskClass: "implement",
      acceptance,
      dependsOn: [],
      status: "running",
      attempts: 0,
      maxAttempts: args.maxAttempts,
      budget,
      ruledOut: [],
      createdAt: now,
      updatedAt: now,
    })
    .run();
  appendEvent(db, {
    objectiveId,
    taskId,
    payload: { type: "task.created", key, title: args.title, dependsOn: [] },
  });

  const attempts: AttemptSummary[] = [];
  let ruledOut: string[] = [];
  let checkpointNote: string | undefined;
  let finalStatus: "done" | "failed" = "failed";
  let committed = false;
  let lastWorktree: WorktreeHandle | undefined;

  for (let attempt = 1; attempt <= args.maxAttempts; attempt++) {
    const runId = newId();
    const sessionId = newSessionId();
    const branch = `exec/${taskId.slice(0, 8)}-attempt-${attempt}`;
    // Deliberately NOT under EXEC_HOME: POLICY-005 denies any write under
    // ".exec/" to keep a worker from touching the supervisor's own database and
    // control state. A worktree is the worker's own output, not supervisor
    // state, so it lives in a separate directory the policy does not match.
    //
    // Fixed under the home directory by default, same reasoning as the database
    // in packages/db/src/client.ts: state must not depend on the invoking
    // shell's cwd, or `exec-agent` run from two different directories quietly
    // becomes two disconnected islands of state.
    const worktreePath = resolve(
      process.env["EXEC_WORKTREES_DIR"] ?? join(homedir(), ".exec-agent", "worktrees"),
      `${taskId}-${attempt}`,
    );

    console.log(`\n--- Attempt ${attempt}/${args.maxAttempts}: spawning worker (session ${sessionId}) ---`);

    const worktree = createWorktree({
      repoPath: args.repoPath,
      worktreePath,
      branch,
      baseRef: args.baseRef,
    });
    lastWorktree = worktree;

    db.insert(runs)
      .values({
        id: runId,
        taskId,
        objectiveId,
        attempt,
        sessionId,
        model: args.model,
        effort: args.effort,
        worktreePath,
        status: "running",
        turns: 0,
        usage: ZERO_USAGE,
        costUsdEstimate: 0,
        startedAt: Date.now(),
      })
      .run();
    appendEvent(db, {
      objectiveId,
      taskId,
      runId,
      payload: {
        type: "run.started",
        sessionId,
        model: args.model,
        worktreePath,
        attempt,
        seededFromCheckpoint: checkpointNote !== undefined,
      },
    });

    const objectivePolicies = activePolicies(db, objectiveId);

    const result = await runWorker({
      sessionId,
      cwd: worktreePath,
      model: args.model,
      effort: args.effort,
      budget,
      prompt: {
        intent: args.intent,
        ruledOut,
        ...(checkpointNote !== undefined ? { checkpointNote } : {}),
      },
      policies: objectivePolicies,
      onEvent: (payload) => {
        appendEvent(db, { objectiveId, taskId, runId, payload });
        const line = formatLiveLine(payload);
        if (line) console.log(line);
      },
      supervisorCallbacks: {
        requestDecision: async (input) => {
          const decisionKeyValue = nextDecisionKey(db);
          db.insert(decisions)
            .values({
              id: newId(),
              key: decisionKeyValue,
              objectiveId,
              taskId,
              runId,
              level: "L2",
              title: input.title,
              context: input.context,
              options: input.options,
              recommendation: input.recommendation,
              risk: input.risk,
              blockedTaskIds: [],
              status: "open",
              createdAt: Date.now(),
            })
            .run();
          appendEvent(db, {
            objectiveId,
            taskId,
            runId,
            payload: {
              type: "decision.raised",
              key: decisionKeyValue,
              level: "L2",
              title: input.title,
              blockedTaskIds: [],
            },
          });

          const answered = await askInTerminal(input);
          answerDecision(db, {
            key: decisionKeyValue,
            answer: answered.answer,
            answeredBy: answered.answeredBy,
          });
          return answered;
        },
        reportProgress: (input) => {
          console.log(`  > ${input.milestone}${input.detail ? `: ${input.detail}` : ""}`);
          appendEvent(db, {
            objectiveId,
            taskId,
            runId,
            payload: { type: "run.progress", milestone: input.milestone, detail: input.detail },
          });
        },
        recordFinding: (input) => {
          console.log(`  ! finding: ${input.title}`);
          appendEvent(db, {
            objectiveId,
            taskId,
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
      `  worker exited: ${result.exitReason} (${result.turns} turns, $${result.costUsdEstimate.toFixed(4)} est.)`,
    );

    if (result.exitReason === "rate_limited") {
      console.log(
        "  rate limit reached. This build runs one task in the foreground and does not " +
          "park/resume yet (that is the scheduler daemon, not built here) — stopping.",
      );
      appendEvent(db, {
        objectiveId,
        taskId,
        runId,
        payload: { type: "note", message: "stopped: rate limited, no scheduler in this build" },
      });
      break;
    }

    let verify: VerifyOutcome | undefined;
    if (result.exitReason === "completed") {
      console.log("  running acceptance checks...");
      verify = runAcceptance(worktreePath, acceptance);
      for (const check of verify.checks) {
        appendEvent(db, {
          objectiveId,
          taskId,
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
        console.log(`    [${check.passed ? "PASS" : "FAIL"}] ${check.label}`);
      }
      appendEvent(db, {
        objectiveId,
        taskId,
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
      committed = commitAll(worktreePath, `${args.title}\n\n${result.resultText ?? ""}`.trim());
      finalStatus = "done";
      setTaskStatus(db, taskId, "done");
      break;
    }

    // Not done: build a mechanical checkpoint (no LLM call — see checkpoint.ts) and,
    // budget permitting, respawn a fresh worker seeded with it.
    const changed = churn(worktreePath);
    const checkpoint = buildCheckpoint({
      taskTitle: args.title,
      intent: args.intent,
      filesChanged: changed.filesChanged,
      ruledOut,
      ...(result.stallSignal !== undefined ? { stallSignal: result.stallSignal } : {}),
      ...(verify !== undefined ? { verify } : {}),
      ...(result.resultText !== undefined ? { resultText: result.resultText } : {}),
    });
    const artifactId = writeArtifact(db, {
      kind: "checkpoint",
      content: checkpoint,
      objectiveId,
      taskId,
      runId,
    });
    appendEvent(db, {
      objectiveId,
      taskId,
      runId,
      payload: { type: "checkpoint.written", artifactId, ruledOutCount: checkpoint.doNotRepeat.length },
    });
    addRuledOut(db, taskId, checkpoint.doNotRepeat);
    ruledOut = [...ruledOut, ...checkpoint.doNotRepeat];
    checkpointNote = renderCheckpointNote(checkpoint);

    removeWorktree(worktree);

    if (attempt === args.maxAttempts) {
      setTaskStatus(db, taskId, "failed");
      console.log(`  attempt budget (${args.maxAttempts}) exhausted.`);
    }
  }

  db.update(objectives)
    .set({ status: finalStatus, updatedAt: Date.now() })
    .where(eq(objectives.id, objectiveId))
    .run();

  const report = renderReport({
    taskTitle: args.title,
    intent: args.intent,
    attempts,
    finalStatus,
    branch: lastWorktree?.branch ?? "-",
    worktreePath: lastWorktree?.path ?? "-",
    committed,
  });
  console.log(report);

  writeArtifact(db, { kind: "report", content: report, objectiveId, taskId });
  console.log(`Objective id: ${objectiveId}`);
  console.log(`Full event log: npm run exec -- events ${objectiveId}`);
  console.log(`Database:       ${dbPath}`);
}
