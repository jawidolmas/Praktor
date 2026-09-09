import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * A mechanical repo briefing — no LLM call, just `git ls-files` plus a few
 * well-known doc files, injected straight into the worker's first prompt.
 *
 * This exists because of what the event logs from real runs actually showed:
 * every single run spent several turns on `find`/`pwd`/`ls`/`Glob` and reading
 * README.md/CURRENT.md before doing anything the task asked for — the same
 * rediscovery, paid again on every run, even back-to-back against the same
 * repo. Handing the worker this up front is strictly cheaper than making it
 * spend tool calls (and turns, and wall-clock, and tokens) discovering it.
 */

export interface RepoBriefing {
  fileList: string[];
  fileListTotal: number;
  docExcerpts: { file: string; excerpt: string; truncated: boolean }[];
}

const DOC_CANDIDATES = ["README.md", "README", "CONTRIBUTING.md", "AGENTS.md", "CLAUDE.md"];
const MAX_FILES_LISTED = 150;
const MAX_EXCERPT_CHARS = 1200;

export interface BuildBriefingInput {
  /** Raw `git ls-files` output, one path per element, repo-relative. */
  trackedFiles: string[];
  /** Read a doc candidate's content, or undefined if it doesn't exist / can't
   *  be read. Kept as a callback so the interesting logic below — sorting,
   *  truncation, rendering — is testable without touching a filesystem. */
  readDoc: (name: string) => string | undefined;
}

/**
 * Depth-first-shallow, then alphabetical. `git ls-files` returns tree order,
 * which for a large repo means the first N entries by that order can all come
 * from one early subdirectory alphabetically — useless as an "at a glance"
 * structure. Sorting by path depth first surfaces root files and top-level
 * directories before diving into any one of them, which is what someone
 * orienting themselves in a repo actually wants to see first.
 */
function sortByDepthThenName(paths: string[]): string[] {
  return paths.slice().sort((a, b) => {
    const depthA = a.split("/").length;
    const depthB = b.split("/").length;
    return depthA !== depthB ? depthA - depthB : a.localeCompare(b);
  });
}

export function buildBriefingFromInput(input: BuildBriefingInput): RepoBriefing {
  const sorted = sortByDepthThenName(input.trackedFiles);
  const fileList = sorted.slice(0, MAX_FILES_LISTED);

  const docExcerpts: RepoBriefing["docExcerpts"] = [];
  for (const name of DOC_CANDIDATES) {
    const content = input.readDoc(name);
    if (content === undefined) continue;
    const truncated = content.length > MAX_EXCERPT_CHARS;
    docExcerpts.push({
      file: name,
      excerpt: truncated ? content.slice(0, MAX_EXCERPT_CHARS) : content,
      truncated,
    });
  }

  return { fileList, fileListTotal: input.trackedFiles.length, docExcerpts };
}

/** The real, I/O-touching version: reads the actual worktree on disk. */
export function buildRepoBriefing(worktreePath: string): RepoBriefing {
  let trackedFiles: string[] = [];
  try {
    trackedFiles = execFileSync("git", ["-C", worktreePath, "ls-files"], {
      encoding: "utf8",
      windowsHide: true,
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    /* not fatal — the briefing is a best-effort head start, not a requirement */
  }

  const readDoc = (name: string): string | undefined => {
    const full = join(worktreePath, name);
    if (!existsSync(full)) return undefined;
    try {
      return readFileSync(full, "utf8");
    } catch {
      return undefined;
    }
  };

  return buildBriefingFromInput({ trackedFiles, readDoc });
}

export function renderBriefing(briefing: RepoBriefing): string {
  if (briefing.fileList.length === 0 && briefing.docExcerpts.length === 0) return "";

  const lines: string[] = [
    "Repository briefing — read this first; it replaces the usual first few " +
      "orientation commands, so you should not need find/ls/pwd or a Glob just to " +
      "see what's here:",
  ];

  if (briefing.fileList.length > 0) {
    const suffix =
      briefing.fileListTotal > briefing.fileList.length
        ? ` (first ${briefing.fileList.length} of ${briefing.fileListTotal})`
        : "";
    lines.push(`\nTracked files${suffix}:`);
    lines.push(briefing.fileList.map((f) => `  ${f}`).join("\n"));
  }

  for (const doc of briefing.docExcerpts) {
    lines.push(`\n--- ${doc.file}${doc.truncated ? " (truncated)" : ""} ---`);
    lines.push(doc.excerpt);
  }

  return lines.join("\n");
}
