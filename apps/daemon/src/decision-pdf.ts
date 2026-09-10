import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

/**
 * The packet the CEO actually reads: what was being worked on, what's paused
 * and why, the decision itself with its full pros/cons, and how to answer.
 * `pdf-lib` (pure JS, no native build step) over anything Chromium-based —
 * this only ever needs fixed, structured text, not a rendered web page, and
 * a headless-browser dependency would be a much heavier, more fragile thing
 * to carry just for that.
 */

export interface DecisionPacketOption {
  id: string;
  label: string;
  pros: string[];
  cons: string[];
}

export interface DecisionPacketArgs {
  objectiveTitle: string;
  taskTitle: string;
  intent: string;
  decisionKey: string;
  decisionTitle: string;
  decisionContext: string;
  options: DecisionPacketOption[];
  recommendation: string;
  risk: string;
  filesChangedSoFar: string[];
}

const MARGIN = 50;
const PAGE_SIZE: [number, number] = [612, 792]; // US Letter
const BODY_SIZE = 11;
const LINE_HEIGHT = 15;
const MAX_LINE_CHARS = 92;

/** Word-wrap to a fixed character width. pdf-lib has no built-in layout —
 *  everything here is short, structured text, so a character-count wrap is
 *  simple and good enough rather than measuring real glyph widths. */
function wrap(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(" ")) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length > maxChars && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

class Writer {
  private page: PDFPage;
  private y: number;

  constructor(
    private doc: PDFDocument,
    private font: PDFFont,
    private bold: PDFFont,
  ) {
    this.page = doc.addPage(PAGE_SIZE);
    this.y = PAGE_SIZE[1] - MARGIN;
  }

  private ensureRoom(): void {
    if (this.y < MARGIN + LINE_HEIGHT) {
      this.page = this.doc.addPage(PAGE_SIZE);
      this.y = PAGE_SIZE[1] - MARGIN;
    }
  }

  heading(text: string): void {
    this.ensureRoom();
    this.page.drawText(text, { x: MARGIN, y: this.y, size: 16, font: this.bold, color: rgb(0.1, 0.1, 0.1) });
    this.y -= LINE_HEIGHT * 1.6;
  }

  subheading(text: string): void {
    this.ensureRoom();
    this.y -= LINE_HEIGHT * 0.3;
    this.page.drawText(text, { x: MARGIN, y: this.y, size: 13, font: this.bold, color: rgb(0.15, 0.15, 0.15) });
    this.y -= LINE_HEIGHT * 1.3;
  }

  paragraph(text: string, opts: { bold?: boolean; indent?: number } = {}): void {
    const font = opts.bold ? this.bold : this.font;
    const indent = opts.indent ?? 0;
    for (const line of wrap(text, MAX_LINE_CHARS - indent)) {
      this.ensureRoom();
      this.page.drawText(line, {
        x: MARGIN + indent,
        y: this.y,
        size: BODY_SIZE,
        font,
        color: rgb(0.2, 0.2, 0.2),
      });
      this.y -= LINE_HEIGHT;
    }
  }

  gap(): void {
    this.y -= LINE_HEIGHT * 0.6;
  }
}

export async function renderDecisionPdf(args: DecisionPacketArgs): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(doc, font, bold);

  w.heading(`Decision needed — ${args.decisionKey}`);
  w.paragraph(args.decisionTitle, { bold: true });
  w.gap();

  w.subheading("Objective");
  w.paragraph(`${args.objectiveTitle} — ${args.taskTitle}`);
  w.paragraph(args.intent);
  w.gap();

  w.subheading("Why this is blocked");
  w.paragraph(args.decisionContext);
  w.gap();

  w.subheading("Options");
  for (const opt of args.options) {
    const flag = opt.id === args.recommendation ? "  (recommended)" : "";
    w.paragraph(`[${opt.id}] ${opt.label}${flag}`, { bold: true });
    for (const pro of opt.pros) w.paragraph(`+ ${pro}`, { indent: 14 });
    for (const con of opt.cons) w.paragraph(`- ${con}`, { indent: 14 });
    w.gap();
  }

  w.subheading("Risk");
  w.paragraph(args.risk);
  w.gap();

  if (args.filesChangedSoFar.length > 0) {
    w.subheading("Files touched so far");
    w.paragraph(args.filesChangedSoFar.join(", "));
    w.gap();
  }

  w.subheading("What happens next");
  w.paragraph(
    "The worker session was stopped to avoid leaving it idling, not because anything went " +
      "wrong. Answer this in Telegram (tap an option) or run " +
      `\`exec-agent decide ${args.decisionKey} <option>\` from any terminal, and a fresh ` +
      "session picks up exactly where this one left off, already told the answer.",
  );

  return doc.save();
}
