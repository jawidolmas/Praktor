import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Worker runs put scratch git worktrees under .exec/ and demo repos under
    // .scratch/ — both can contain files that look like tests to a *.test.*
    // glob (e.g. a worker-authored math.test.mjs) without being part of this
    // codebase's own suite.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      ".exec/**",
      ".scratch/**",
    ],
  },
});
