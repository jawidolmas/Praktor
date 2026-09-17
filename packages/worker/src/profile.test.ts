import { describe, expect, it } from "vitest";
import { renderEngineeringProfile } from "./profile.js";

describe("renderEngineeringProfile", () => {
  it("renders to an empty string with no entries, so a profile-less system is unchanged", () => {
    expect(renderEngineeringProfile([])).toBe("");
  });

  it("renders each entry as a labeled line, in the order given", () => {
    const rendered = renderEngineeringProfile([
      { title: "Architecture", content: "Prefer simple systems." },
      { title: "Dependencies", content: "Avoid unnecessary dependencies." },
    ]);

    expect(rendered).toContain("- Architecture: Prefer simple systems.");
    expect(rendered).toContain("- Dependencies: Avoid unnecessary dependencies.");
    expect(rendered.indexOf("Architecture")).toBeLessThan(rendered.indexOf("Dependencies"));
  });
});
