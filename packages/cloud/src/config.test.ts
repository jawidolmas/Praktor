import { describe, expect, it } from "vitest";
import { validateCloudConfig } from "./config.js";

const URL_OK = "https://abcdefghijklmnop.supabase.co";

function fakeJwt(role: string): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "HS256" })}.${part({ role, iss: "supabase" })}.signature`;
}

describe("validateCloudConfig", () => {
  it("accepts a publishable key and normalizes the URL to its origin", () => {
    expect(validateCloudConfig(`${URL_OK}/rest/v1`, " sb_publishable_abc ")).toEqual({
      ok: true,
      config: { url: URL_OK, key: "sb_publishable_abc" },
    });
  });

  it("accepts a legacy anon JWT", () => {
    expect(validateCloudConfig(URL_OK, fakeJwt("anon")).ok).toBe(true);
  });

  it("refuses a secret key, whatever its format", () => {
    for (const key of ["sb_secret_abc", fakeJwt("service_role")]) {
      const result = validateCloudConfig(URL_OK, key);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/secret/);
    }
  });

  it("refuses plain http and junk", () => {
    expect(validateCloudConfig("http://abc.supabase.co", "sb_publishable_x").ok).toBe(false);
    expect(validateCloudConfig("not a url", "sb_publishable_x").ok).toBe(false);
    expect(validateCloudConfig(URL_OK, "hello").ok).toBe(false);
    expect(validateCloudConfig(undefined, undefined).ok).toBe(false);
  });
});
