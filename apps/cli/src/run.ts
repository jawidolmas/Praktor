import { resolve } from "node:path";
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
 * Load the seed policy set into the database exactly once. A repo the CLI has
 * already run against keeps whatever policies were edited there afterwards —
 * this only fills an empty table.
 */
function ensureSeedPolicies(db: ReturnType<typeof openDb>["db"]): void {
  const existing = db.select().from(policies).limit(1).all();
  if (existing.length > 0) return;
  const now = Date.now();
  for (let i = 0; i < SEED_POLICIES.length; i++) {
    const seed = SEED_POLICIES[i]!;
    db.insert(policies)
      .values({
        id: newId(),
        key: `POLICY-${String(i + 1).padStart(3, "0")}`,
        ...seed,
        createdAt: now,
      })
      .run();
  }
  console.log(`Seeded ${SEED_POLICIES.length} default policies.`);
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
  ensureSeedPolicies(db);

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
    const worktreePath = resolve(
      process.env["EXEC_HOME"] ?? ".exec",
      "worktrees",
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
      onEvent: (payload) => appendEvent(db, { objectiveId, taskId, runId, payload }),
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
