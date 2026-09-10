import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decisions, execHome, type Db, type ObjectiveRow, type TaskRow } from "@exec/db";
import { churn } from "@exec/worker";
import { sendDocument } from "@exec/telegram";
import { eq } from "drizzle-orm";
import { renderDecisionPdf } from "./decision-pdf.js";
import { loadTelegramConfig } from "./telegram-bridge.js";

/**
 * Builds and sends the PDF packet for a decision whose run just got stopped
 * by its deadline. Deliberately isolated from `engine.ts`'s actual task
 * loop: nothing here may ever throw out to the caller — a broken PDF
 * renderer or a flaky Telegram call must not stop the attempt from later
 * resuming once someone answers, the same principle already applied to the
 * Telegram bridge itself not being allowed to take the daemon down.
 *
 * A no-op when Telegram isn't configured: there's currently nowhere else to
 * deliver a PDF to, and the CLI/dashboard escalation path doesn't need one.
 */
export async function sendDecisionPacket(
  db: Db,
  objective: ObjectiveRow,
  task: TaskRow,
  decisionKeyValue: string,
  worktreePath: string,
): Promise<void> {
  const config = loadTelegramConfig();
  if (!config) return;

  try {
    const row = db.select().from(decisions).where(eq(decisions.key, decisionKeyValue)).get();
    if (!row) return;

    const bytes = await renderDecisionPdf({
      objectiveTitle: objective.title,
      taskTitle: task.title,
      intent: task.intent,
      decisionKey: row.key,
      decisionTitle: row.title,
      decisionContext: row.context,
      options: row.options,
      recommendation: row.recommendation,
      risk: row.risk,
      filesChangedSoFar: churn(worktreePath).filesChanged,
    });

    const dir = mkdtempSync(join(execHome(), "tmp-"));
    const pdfPath = join(dir, `${row.key}.pdf`);
    try {
      writeFileSync(pdfPath, bytes);
      await sendDocument(config.token, config.chatId, pdfPath, {
        caption: `${row.key}: ${row.title} — paused, waiting on you.`,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`[telegram] failed to send the decision packet for ${decisionKeyValue}:`, err);
  }
}
