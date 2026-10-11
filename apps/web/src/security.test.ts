import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  PAIRING_TTL_MS,
  PairingCodes,
  RateLimiter,
  bearerToken,
  isLocalHostHeader,
  isLoopbackAddress,
  isSameOriginJsonWrite,
  isTailscaleAddress,
  resolvePublicUrl,
  sanitizeDeviceName,
} from "./security.js";

function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("isLoopbackAddress", () => {
  it("accepts IPv4/IPv6 loopback, including v4-mapped", () => {
    for (const a of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackAddress(a)).toBe(true);
  });
  it("rejects everything else", () => {
    for (const a of [undefined, "", "100.101.102.103", "192.168.1.2", "::ffff:10.0.0.1", "1270.0.0.1"]) {
      expect(isLoopbackAddress(a)).toBe(false);
    }
  });
});

describe("isLocalHostHeader (DNS rebinding)", () => {
  it("accepts loopback names with or without a port", () => {
    for (const h of ["localhost:4317", "127.0.0.1:4317", "[::1]:4317", "LOCALHOST"]) expect(isLocalHostHeader(h)).toBe(true);
  });
  it("rejects any other name, even one resolving to 127.0.0.1", () => {
    for (const h of [undefined, "evil.example:4317", "localhost.evil.example", "machine.tailnet.ts.net"]) {
      expect(isLocalHostHeader(h)).toBe(false);
    }
  });
});

describe("isSameOriginJsonWrite (CSRF)", () => {
  const host = "127.0.0.1:4317";
  it("accepts the dashboard's own JSON POST", () => {
    expect(
      isSameOriginJsonWrite(
        req({ host, "content-type": "application/json", origin: "http://127.0.0.1:4317", "sec-fetch-site": "same-origin" }),
      ),
    ).toBe(true);
  });
  it("rejects a preflight-free text/plain body", () => {
    expect(isSameOriginJsonWrite(req({ host, "content-type": "text/plain" }))).toBe(false);
  });
  it("rejects a foreign Origin", () => {
    expect(isSameOriginJsonWrite(req({ host, "content-type": "application/json", origin: "https://evil.example" }))).toBe(false);
  });
  it("rejects a loopback Origin on a different port", () => {
    expect(isSameOriginJsonWrite(req({ host, "content-type": "application/json", origin: "http://127.0.0.1:9999" }))).toBe(false);
  });
  it("rejects a cross-site fetch", () => {
    expect(isSameOriginJsonWrite(req({ host, "content-type": "application/json", "sec-fetch-site": "cross-site" }))).toBe(false);
  });
});

describe("bearerToken", () => {
  it("extracts a well-formed token", () => {
    expect(bearerToken(req({ authorization: "Bearer pk_abc-DEF_123" }))).toBe("pk_abc-DEF_123");
  });
  it("ignores other schemes and junk", () => {
    expect(bearerToken(req({}))).toBeUndefined();
    expect(bearerToken(req({ authorization: "Basic abc" }))).toBeUndefined();
    expect(bearerToken(req({ authorization: "Bearer a b" }))).toBeUndefined();
  });
});

describe("PairingCodes", () => {
  it("is single-use", () => {
    const p = new PairingCodes();
    const { code } = p.create(0);
    expect(p.consume(code, 1)).toBe(true);
    expect(p.consume(code, 2)).toBe(false);
  });
  it("expires", () => {
    const p = new PairingCodes();
    const { code } = p.create(0);
    expect(p.consume(code, PAIRING_TTL_MS + 1)).toBe(false);
  });
  it("invalidates the previous code when a new one is shown", () => {
    const p = new PairingCodes();
    const first = p.create(0).code;
    const second = p.create(1).code;
    expect(p.consume(first, 2)).toBe(false);
    expect(p.consume(second, 3)).toBe(true);
  });
  it("survives a wrong guess", () => {
    const p = new PairingCodes();
    const { code } = p.create(0);
    expect(p.consume("wrong", 1)).toBe(false);
    expect(p.consume(code, 2)).toBe(true);
  });
  it("can be cancelled", () => {
    const p = new PairingCodes();
    const { code } = p.create(0);
    p.cancel();
    expect(p.consume(code, 1)).toBe(false);
  });
});

describe("RateLimiter", () => {
  it("allows up to the limit per window, then resets", () => {
    const r = new RateLimiter(2, 1000);
    expect([r.allow("a", 0), r.allow("a", 1), r.allow("a", 2)]).toEqual([true, true, false]);
    expect(r.allow("b", 2)).toBe(true);
    expect(r.allow("a", 1000)).toBe(true);
  });
});

describe("sanitizeDeviceName", () => {
  it("strips control and bidi-override characters and caps length", () => {
    expect(sanitizeDeviceName("  iPhone\u0000‮ 17 ")).toBe("iPhone 17");
    expect(sanitizeDeviceName("x".repeat(100))).toHaveLength(64);
  });
  it("rejects empty or non-string names", () => {
    expect(sanitizeDeviceName("\u0001  ")).toBeUndefined();
    expect(sanitizeDeviceName(42)).toBeUndefined();
  });
});

describe("resolvePublicUrl", () => {
  const ts = { tailscale0: [{ family: "IPv4", address: "100.88.1.2" } as never] };
  it("prefers an explicit URL, reduced to its origin", () => {
    expect(resolvePublicUrl({ explicit: "https://box.tail1.ts.net/x", boundHost: "127.0.0.1", port: 4317, interfaces: ts })).toEqual({
      ok: true,
      url: "https://box.tail1.ts.net",
    });
  });
  it("rejects a non-http explicit URL", () => {
    expect(resolvePublicUrl({ explicit: "javascript:alert(1)", boundHost: "127.0.0.1", port: 1, interfaces: {} }).ok).toBe(false);
  });
  it("uses the Tailscale address only when actually listening on it", () => {
    expect(resolvePublicUrl({ explicit: undefined, boundHost: "100.88.1.2", port: 4317, interfaces: ts })).toEqual({
      ok: true,
      url: "http://100.88.1.2:4317",
    });
    expect(resolvePublicUrl({ explicit: undefined, boundHost: "127.0.0.1", port: 4317, interfaces: ts }).ok).toBe(false);
  });
  it("never falls back to a LAN address", () => {
    const lan = { eth0: [{ family: "IPv4", address: "192.168.1.5" } as never] };
    expect(resolvePublicUrl({ explicit: undefined, boundHost: "0.0.0.0", port: 4317, interfaces: lan }).ok).toBe(false);
  });
  it("recognises only the 100.64.0.0/10 range as Tailscale", () => {
    expect(isTailscaleAddress("100.64.0.1")).toBe(true);
    expect(isTailscaleAddress("100.127.255.255")).toBe(true);
    expect(isTailscaleAddress("100.63.0.1")).toBe(false);
    expect(isTailscaleAddress("100.128.0.1")).toBe(false);
  });
});
