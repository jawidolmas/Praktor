import { describe, expect, it } from "vitest";
import { parseAutostartStatusOutput } from "./autostart.js";

describe("parseAutostartStatusOutput", () => {
  it("reports not installed when no task exists", () => {
    expect(parseAutostartStatusOutput("NOT_INSTALLED")).toEqual({ installed: false });
  });

  it("reports the logon mode", () => {
    expect(parseAutostartStatusOutput("INSTALLED:logon")).toEqual({ installed: true, mode: "logon" });
  });

  it("reports the boot mode", () => {
    expect(parseAutostartStatusOutput("INSTALLED:boot")).toEqual({ installed: true, mode: "boot" });
  });

  it("still reports installed for a trigger type it doesn't recognize, just with no mode", () => {
    expect(parseAutostartStatusOutput("INSTALLED:other")).toEqual({ installed: true });
  });

  it("treats blank output the same as not installed, rather than crashing", () => {
    expect(parseAutostartStatusOutput("")).toEqual({ installed: false });
  });
});
