import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { git } from "@exec/worker";

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

const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Locational-preposition mentions: "in my-project", "for the my-project
 * repo", "to my-project". This is what actually distinguishes a sentence
 * naming its target repo from a repo's name showing up as an ordinary word
 * elsewhere in the request — this project is itself named "agent", and "agent"
 * is also just an English word, so "Hello, agent" as file content must not be
 * read as naming the repo. A global regex is re-instantiated per call since it
 * is stateful (lastIndex) and this function must be safe to call repeatedly.
 *
 * The captured character class includes `/` and `\` (and `~`) so a path like
 * "Desktop/website" or "~/Desktop/website" is captured as one token instead
 * of truncating at the first slash — `resolveCreateTarget` below depends on
 * seeing the whole path, not just its first segment.
 */
function extractPrepositionalMentions(text: string): string[] {
  const pattern = /\b(?:in|into|inside|within|for|on|at|to)\s+(?:the\s+)?([A-Za-z0-9~][A-Za-z0-9._/\\:-]*)/gi;
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

/** True when `candidate` is `root` itself or somewhere underneath it. */
function isUnder(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Only meant to be tried once `resolveRepoFromText` has already come back
 * with no match and no ambiguity — this is what turns "build it in
 * Desktop/website" into somewhere to actually create, without touching the
 * fail-closed behavior for a bare, possibly-mistyped name.
 *
 * Deliberately conservative: a bare mention like "myprojject" is
 * indistinguishable from a typo of an existing "my-project" repo, and
 * guessing wrong there means silently creating a stray junk repo. An
 * explicit path rooted at a known search root ("Desktop/website",
 * "~/Desktop/website", or an absolute path already under a search root) has
 * no such ambiguity — the sentence said where — so only that counts here.
 * Anything looser still returns undefined, and the caller's existing
 * "couldn't find a repo" error applies exactly as before.
 */
export function resolveCreateTarget(text: string, roots: string[] = searchRoots()): string | undefined {
  for (const raw of extractPrepositionalMentions(text)) {
    const mention = raw.replace(/\\/g, "/");
    let candidate: string;

    if (mention.startsWith("~/")) {
      candidate = join(homedir(), mention.slice(2));
    } else if (/^[A-Za-z]:\//.test(mention) || mention.startsWith("/")) {
      candidate = resolvePath(mention);
    } else {
      const segments = mention.split("/").filter(Boolean);
      if (segments.length < 2) continue; // no explicit root — e.g. a bare "website"
      const [first, ...rest] = segments;
      const root = roots.find((r) => basename(r).toLowerCase() === first!.toLowerCase());
      if (!root) continue;
      candidate = join(root, ...rest);
    }

    if (roots.some((root) => isUnder(candidate, root))) return candidate;
  }
  return undefined;
}

/**
 * Only ever called when `path` does not already exist on disk — see
 * `resolveCreateTarget`'s caller. The empty commit is load-bearing, not
 * cosmetic: a fresh `git init` has an unborn HEAD, and `createWorktree`'s
 * `git worktree add -B <branch> <path> <baseRef>` (worktree.ts) needs a real
 * commit to branch from — the first attempt would otherwise fail immediately
 * on worktree creation.
 */
export function createRepoAt(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-q", "-b", "main"]);
  git(path, ["commit", "--allow-empty", "-q", "-m", "Initial commit"]);
}
