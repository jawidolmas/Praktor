#!/usr/bin/env node
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * The globally-linked entry point (`npm link` from the project root makes
 * `exec-agent` resolve here from any directory).
 *
 * The CLI itself is TypeScript, run through tsx rather than compiled ahead of
 * time — this wrapper just locates tsx's own CLI script via `require.resolve`
 * (which follows tsx's package.json exports, so it survives a tsx version bump)
 * and hands off to it as a child process. No shell involved, so Windows argument
 * quoting is never a concern.
 */

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const tsxCli = require.resolve("tsx/cli");
const cliEntry = join(here, "..", "apps", "cli", "src", "index.ts");

const result = spawnSync(process.execPath, [tsxCli, cliEntry, ...process.argv.slice(2)], {
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
