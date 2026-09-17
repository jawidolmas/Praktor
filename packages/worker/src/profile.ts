/**
 * Rendering the standing engineering profile into prompt text — the piece
 * that turns "Praktor knows Jawid's preferences" into every brain call
 * actually seeing them. Deliberately a pure function over plain data, the
 * same shape as `briefing.ts`'s `renderBriefing`: this package stays
 * DB-agnostic (it never imports `@exec/db`), so the daemon is the one place
 * that reads the `memories` table and hands the rendered string down.
 */

export interface ProfileEntry {
  title: string;
  content: string;
}

export function renderEngineeringProfile(entries: ProfileEntry[]): string {
  if (entries.length === 0) return "";

  const lines = [
    "Standing engineering profile — apply these preferences unless the task " +
      "explicitly asks for something that overrides one of them:",
  ];
  for (const entry of entries) {
    lines.push(`- ${entry.title}: ${entry.content}`);
  }
  return lines.join("\n");
}
