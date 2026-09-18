import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The `graphify` integration: a local, LLM-free knowledge graph of a repo
 * (tree-sitter AST — no tokens spent building or rebuilding it), handed to
 * every worker as a second MCP server so "how does X call Y" or "what would
 * this break" is answered by a targeted graph query instead of grepping and
 * reading raw files from scratch in every attempt.
 *
 * graphify is an external dependency (Apache-2.0, installed separately via
 * `uv tool install 'graphifyy[mcp]'`) — this module only ever shells out to
 * its existing CLI (`graphify update`) and MCP server (`graphify-mcp`); it
 * does not reimplement any part of its extraction/build pipeline.
 */

/** Exported so a caller who already knows the answer (e.g. a test) doesn't
 *  have to re-derive the convention. Kept outside `$EXEC_WORKTREES_DIR` —
 *  a graph reflects the repo, not any one attempt's worktree, and is shared
 *  across every task/attempt run against that repo. */
export function graphsDir(): string {
  return resolve(process.env["EXEC_GRAPHS_DIR"] ?? join(homedir(), ".exec-agent", "graphs"));
}

/** A short, stable, filesystem-safe key for a repo path — not a security
 *  boundary, just enough to keep one cache directory per repo without
 *  fighting path separators or length limits. */
export function hashRepoPath(repoPath: string): string {
  return createHash("sha1").update(resolve(repoPath)).digest("hex").slice(0, 16);
}

export function graphCacheDirFor(repoPath: string): string {
  return join(graphsDir(), hashRepoPath(repoPath));
}

/** Where `graphify-mcp` should be pointed for this repo — always this same
 *  path, whether or not a graph has actually been built there yet. */
export function graphJsonPathFor(repoPath: string): string {
  return join(graphCacheDirFor(repoPath), "graph.json");
}

const INSTALL_HINT =
  "Install it with: uv tool install 'graphifyy[mcp]' (the [mcp] extra is required for " +
  "graphify-mcp). See https://github.com/Graphify-Labs/graphify.";

export interface GraphifyAvailability {
  ok: boolean;
  message?: string;
}

// Checked once per daemon process lifetime — not worth a subprocess spawn on
// every single task once we already know the answer.
let installCheckCache: GraphifyAvailability | undefined;

/** Whether `graphify` (and by extension `graphify-mcp`, installed from the
 *  same package) is on PATH. graphify is a hard prerequisite for Praktor —
 *  this exists so a missing install produces one clear, actionable message
 *  instead of a raw ENOENT the first time something tries to shell out to it. */
export function checkGraphifyInstalled(): GraphifyAvailability {
  if (installCheckCache) return installCheckCache;
  try {
    execFileSync("graphify", ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    installCheckCache = { ok: true };
  } catch {
    installCheckCache = {
      ok: false,
      message: `graphify is not installed or not on PATH. ${INSTALL_HINT}`,
    };
  }
  return installCheckCache;
}

/** Test-only escape hatch — the module-level cache above is deliberate for
 *  real runs (one subprocess spawn per daemon lifetime, not per task), but a
 *  test exercising both the installed and not-installed paths needs to reset
 *  it between cases. */
export function resetGraphifyInstallCache(): void {
  installCheckCache = undefined;
}

/** The MCP stdio server config for `graphify-mcp`, pointed at a given
 *  graph.json — the same shape every caller that hands a worker/judge/
 *  diagnoser session graphify access needs, kept in one place so the
 *  command name and argv shape can't drift between them. Typed loosely
 *  (not against the Agent SDK's `McpServerConfig`) so this module — like
 *  the rest of `packages/worker` — stays SDK-agnostic; the shape is a
 *  structural subset of `McpStdioServerConfig`, which is all that matters
 *  where callers assign it into an `Options["mcpServers"]` map. */
export interface GraphifyMcpServerConfig {
  command: "graphify-mcp";
  args: [string];
}

export function graphifyMcpServer(graphPath: string): GraphifyMcpServerConfig {
  return { command: "graphify-mcp", args: [graphPath] };
}

export interface EnsureGraphResult {
  available: boolean;
  graphPath: string;
  error?: string;
}

/**
 * Build or incrementally refresh the graph for a repo, returning the path
 * `graphify-mcp` should be started against. `graphify update` already does
 * the full deterministic pipeline (detect/extract/build/cluster/export) with
 * no LLM and no pre-existing graph required — it bootstraps on first call and
 * re-extracts only changed files afterwards, entirely on its own, so there is
 * no bespoke caching logic here beyond pointing its output at a stable path
 * via `GRAPHIFY_OUT`.
 *
 * A build failure for this specific repo (unsupported layout, transient
 * error, etc.) is reported back rather than thrown — the caller runs the
 * worker without the graphify MCP server that attempt, the same graceful
 * degradation other imperfect signals in this codebase already get. A
 * missing `graphify` install entirely is the actual hard-dependency gate
 * (see `checkGraphifyInstalled`), surfaced the same way so it is never
 * silently indistinguishable from "this one repo failed to build."
 */
export function ensureGraphForRepo(repoPath: string): EnsureGraphResult {
  const graphPath = graphJsonPathFor(repoPath);
  const installed = checkGraphifyInstalled();
  if (!installed.ok) {
    return { available: false, graphPath, ...(installed.message ? { error: installed.message } : {}) };
  }

  try {
    // The repo path is passed absolute (not the subprocess cwd) so graphify's
    // own root resolution is correct regardless of the daemon's own cwd.
    execFileSync("graphify", ["update", resolve(repoPath)], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, GRAPHIFY_OUT: graphCacheDirFor(repoPath) },
    });
    return { available: true, graphPath };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { available: false, graphPath, error: `graphify update failed: ${detail}` };
  }
}
