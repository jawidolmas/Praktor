import type { EffortLevel } from "@exec/core";
import { appendEvent, createTasksFromPlan, listMemories, type Db, type ObjectiveRow } from "@exec/db";
import { decompose, weakChangedCheck } from "@exec/worker";

/**
 * Turn a "draft" objective (submitted, not yet broken into tasks) into a real
 * task graph. Runs in the daemon, not the CLI: decomposition is itself a
 * brain call that can take real wall-clock time, and the whole point of the
 * daemon existing is that closing the terminal that submitted an objective
 * must not stop work on it — including the planning step.
 *
 * A planning failure (the brain call errors, or the model never calls
 * submit_plan) does not block the objective forever: it falls back to the
 * same single generic task the old regex-only "do" command used to hand
 * back, so "own the objective" never degrades into "refuse to accept it."
 */
export async function planObjective(db: Db, objective: ObjectiveRow): Promise<void> {
  const startedAt = Date.now();
  try {
    const { plan, durationMs } = await decompose({
      title: objective.title,
      brief: objective.brief,
      repoPath: objective.repoPath,
      model: objective.model,
      profile: listMemories(db, "permanent"),
    });
    appendEvent(db, {
      objectiveId: objective.id,
      payload: { type: "brain.call", site: "decompose", ok: true, durationMs, model: objective.model },
    });
    const tasks = createTasksFromPlan(db, {
      objectiveId: objective.id,
      plan,
      model: objective.model,
      effort: objective.effort as EffortLevel,
      maxAttempts: objective.maxAttempts,
      budget: objective.budget,
    });
    console.log(`[${objective.id.slice(0, 8)}] planned ${tasks.length} task(s)`);
  } catch (err) {
    console.error(
      `[${objective.id.slice(0, 8)}] planning failed, falling back to a single generic task:`,
      err,
    );
    appendEvent(db, {
      objectiveId: objective.id,
      payload: { type: "brain.call", site: "decompose", ok: false, durationMs: Date.now() - startedAt, model: objective.model },
    });
    createTasksFromPlan(db, {
      objectiveId: objective.id,
      plan: {
        tasks: [
          {
            key: "T-001",
            title: objective.title,
            intent: objective.brief || objective.title,
            taskClass: "implement",
            dependsOn: [],
            acceptance: { checks: [weakChangedCheck()] },
          },
        ],
      },
      model: objective.model,
      effort: objective.effort as EffortLevel,
      maxAttempts: objective.maxAttempts,
      budget: objective.budget,
    });
  }
}
