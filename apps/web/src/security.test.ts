import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { isLocalHostHeader, isLoopbackAddress, isSameOriginJsonWrite } from "./security.js";

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
