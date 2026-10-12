import { readFileSync } from "node:fs";

/**
 * What this build of the daemon can do for the phone, reported with every
 * heartbeat. The app checks this before offering an action, so a computer
 * still running an older build says "restart Praktor" up front instead of
 * leaving a request that nothing will ever pick up. Add to it whenever the
 * daemon learns to handle a new kind of request from the app.
 */
export const HOST_CAPABILITIES = ["answers", "merges"] as const;

export const AGENT_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
})();
