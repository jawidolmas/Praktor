import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Turn "in my-project" into an actual repo path.
 *
 * This deliberately does not guess when it isn't sure: zero matches or more than
 * one both fail closed with the candidate list printed, rather than picking the
 * "most likely" repo and possibly running against the wrong one.
 */

export interface RepoCandidate {
  name: string;
  path: string;
}

function searchRoots(): string[] {
  const extra = (process.env["EXEC_REPO_SEARCH_PATHS"] ?? "")
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  // Desktop is where this project and the repos tested against it so far both
  // live. EXEC_REPO_SEARCH_PATHS extends the list for anyone whose repos live
  // elsewhere.
  return [join(homedir(), "Desktop"), ...extra];
}

/** Every git repo found one level down from the search roots. */
export function findGitRepos(): RepoCandidate[] {
  const found: RepoCandidate[] = [];
  for (const root of searchRoots()) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // root doesn't exist or isn't readable — skip it, not fatal
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name);
      if (existsSync(join(path, ".git"))) {
        found.push({ name: entry.name, path });
      }
    }
  }
  return found;
}

const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Locational-preposition mentions: "in my-project", "for the my-project
 * repo", "to my-project". This is what actually distinguishes a sentence
 * naming its target repo from a repo's name showing up as an ordinary word
 * elsewhere in the request — this project is itself named "agent", and "agent"
 * is also just an English word, so "Hello, agent" as file content must not be
 * read as naming the repo. A global regex is re-instantiated per call since it
 * is stateful (lastIndex) and this function must be safe to call repeatedly.
 */
function extractPrepositionalMentions(text: string): string[] {
  const pattern = /\b(?:in|into|inside|within|for|on|at|to)\s+(?:the\s+)?([A-Za-z0-9][A-Za-z0-9._-]*)/gi;
  const mentions: string[] = [];
  for (const m of text.matchAll(pattern)) {
    if (m[1]) mentions.push(m[1]);
  }
  return mentions;
}

export interface ResolveRepoResult {
  match?: RepoCandidate;
  /** Every repo found under the search roots, for a helpful error message. */
  known: RepoCandidate[];
  /** More than one repo's name appeared in the text — genuinely ambiguous. */
  ambiguous: RepoCandidate[];
}

/**
 * Find the one repo under the search roots the text names as its target.
 *
 * Two passes: first, only names explicitly called out with a locational
 * preposition — precise, and what real requests actually look like. Only if
 * that finds nothing does it fall back to a broad "the name appears anywhere in
 * the text" scan, for phrasings without a preposition (e.g. "my-project:
 * add X") — looser, but better than refusing outright.
 */
export function resolveRepoFromText(
  text: string,
  known: RepoCandidate[] = findGitRepos(),
): ResolveRepoResult {
  const mentioned = new Set(extractPrepositionalMentions(text).map(normalize));
  const preciseHits = known.filter((c) => mentioned.has(normalize(c.name)));
  if (preciseHits.length === 1) return { match: preciseHits[0]!, known, ambiguous: [] };
  if (preciseHits.length > 1) return { known, ambiguous: preciseHits };

  const haystack = normalize(text);
  const looseHits = known.filter((c) => haystack.includes(normalize(c.name)));
  if (looseHits.length === 1) return { match: looseHits[0]!, known, ambiguous: [] };
  if (looseHits.length > 1) return { known, ambiguous: looseHits };
  return { known, ambiguous: [] };
}
