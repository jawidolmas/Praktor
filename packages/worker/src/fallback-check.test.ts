import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { weakChangedCheck } from "./fallback-check.js";

describe("weakChangedCheck", () => {
  it("points at a script that actually exists, so a fallback objective doesn't fail before it starts", () => {
    const check = weakChangedCheck();
    expect(check.label).toBe("something changed");
    expect(check.expectExitCode).toBe(0);

    const scriptPath = /"([^"]+check-repo-changed\.mjs)"/.exec(check.command)?.[1];
    expect(scriptPath).toBeTruthy();
    expect(existsSync(scriptPath!)).toBe(true);
  });
});
