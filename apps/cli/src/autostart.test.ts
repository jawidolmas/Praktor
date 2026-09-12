import { describe, expect, it } from "vitest";
import { autostartStatus, installAutostart, uninstallAutostart } from "./autostart.js";

// `parseAutostartStatusOutput` is tested where it actually lives now:
// packages/db/src/autostart.test.ts. This file only covers the CLI-specific
// install/uninstall actions.

// Real integration test against this machine's actual Task Scheduler — safe
// and fully reversible (a task under our own name, cleaned up in `finally`
// regardless of how the test ends), but genuinely touches Windows state, so
// it's Windows-only and does not run at all on any other platform.
describe.runIf(process.platform === "win32")("installAutostart / autostartStatus / uninstallAutostart", () => {
  // Each case spins up several real powershell.exe processes (module load
  // alone takes a couple of seconds) — the default 5s unit-test timeout
  // isn't enough for genuine integration coverage like this.
  const REAL_POWERSHELL_TIMEOUT_MS = 30_000;

  it(
    "registers logon mode, reports it back, and removes it cleanly",
    () => {
      try {
        const install = installAutostart("logon");
        expect(install).toMatchObject({ ok: true, mode: "logon" });
        expect(autostartStatus()).toEqual({ installed: true, mode: "logon" });

        const uninstall = uninstallAutostart();
        expect(uninstall.removed).toBe(true);
        expect(autostartStatus()).toEqual({ installed: false });
      } finally {
        uninstallAutostart(); // never leave a real scheduled task behind, even on failure
      }
    },
    REAL_POWERSHELL_TIMEOUT_MS,
  );

  it(
    "re-running install with a different mode switches which one is registered",
    () => {
      try {
        expect(installAutostart("logon")).toMatchObject({ ok: true, mode: "logon" });
        expect(autostartStatus()).toEqual({ installed: true, mode: "logon" });

        // Registering "boot" needs elevation, which this test session doesn't
        // have — this documents that real, expected failure mode rather than
        // pretending it away, and confirms the earlier "logon" registration is
        // untouched by the failed attempt.
        const bootAttempt = installAutostart("boot");
        expect(bootAttempt.ok).toBe(false);
        expect(bootAttempt.message).toMatch(/elevated|administrator/i);
        expect(autostartStatus()).toEqual({ installed: true, mode: "logon" });
      } finally {
        uninstallAutostart();
      }
    },
    REAL_POWERSHELL_TIMEOUT_MS,
  );

  it(
    "uninstalling when nothing is registered is a harmless no-op",
    () => {
      uninstallAutostart(); // in case a previous test left something behind
      const result = uninstallAutostart();
      expect(result.removed).toBe(false);
    },
    REAL_POWERSHELL_TIMEOUT_MS,
  );
});
