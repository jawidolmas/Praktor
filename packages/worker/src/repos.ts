import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where Praktor looks for your git repos — shared by `exec-agent do` (which
 * matches a repo named in a sentence) and the cloud sync (which offers the
 * same list, by folder name only, as the repo picker on the phone).
 */

export interface RepoCandidate {
  name: string;
  path: string;
}

export function searchRoots(): string[] {
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
