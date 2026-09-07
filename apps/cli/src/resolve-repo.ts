import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Turn "in takil-workspace" into an actual repo path.
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

export interface ResolveRepoResult {
  match?: RepoCandidate;
  /** Every repo found under the search roots, for a helpful error message. */
  known: RepoCandidate[];
  /** More than one repo's name appeared in the text — genuinely ambiguous. */
  ambiguous: RepoCandidate[];
}

/** Find the one repo under the search roots whose name is mentioned in the text. */
export function resolveRepoFromText(text: string): ResolveRepoResult {
  const known = findGitRepos();
  const haystack = normalize(text);
  const hits = known.filter((c) => haystack.includes(normalize(c.name)));

  if (hits.length === 1) return { match: hits[0]!, known, ambiguous: [] };
  if (hits.length > 1) return { known, ambiguous: hits };
  return { known, ambiguous: [] };
}
