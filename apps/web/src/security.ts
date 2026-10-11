import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { NetworkInterfaceInfo } from "node:os";

/**
 * The trust boundary between the two halves of this server:
 *
 * - The browser dashboard and its `/api/*` routes have no login. They are
 *   only safe because nothing but this machine can reach them, so that has
 *   to be enforced per request, not assumed from the bind address — a
 *   reverse proxy on loopback (`tailscale serve`, Caddy, …) would otherwise
 *   hand every remote request a loopback socket.
 * - `/api/v1/*` is the companion-app API and always requires a device token,
 *   whoever is asking and however they arrived.
 */

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Headers any common reverse proxy adds. Their presence on a loopback
 *  socket means the request really came from somewhere else. */
const PROXY_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-real-ip",
  "forwarded",
  "tailscale-user-login",
  "tailscale-headers-info",
];

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  return v4 === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/** Hostname part of a Host header, without its port. */
function hostnameOf(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.indexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

/** Blocks DNS rebinding: a hostile page whose domain resolves to 127.0.0.1
 *  still sends its own domain in Host. */
export function isLocalHostHeader(host: string | undefined): boolean {
  return host !== undefined && LOOPBACK_HOSTNAMES.has(hostnameOf(host.trim().toLowerCase()));
}

export function hasProxyHeaders(req: IncomingMessage): boolean {
  return PROXY_HEADERS.some((h) => req.headers[h] !== undefined);
}

/** True only for a request that physically originated on this machine and
 *  is addressed to it by a loopback name. */
export function isLocalRequest(req: IncomingMessage): boolean {
  return isLoopbackAddress(req.socket.remoteAddress) && isLocalHostHeader(req.headers.host) && !hasProxyHeaders(req);
}

/**
 * CSRF guard for the dashboard's state-changing routes. A page on any other
 * site can make the browser POST to 127.0.0.1 — and a `text/plain` body even
 * skips the CORS preflight. Requiring a JSON content type forces a
 * preflight (which this server never approves), and Origin / Sec-Fetch-Site
 * are checked as well for browsers that send them.
 */
export function isSameOriginJsonWrite(req: IncomingMessage): boolean {
  const contentType = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (contentType !== "application/json") return false;

  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") return false;

  const origin = req.headers.origin;
  if (origin !== undefined) {
    try {
      const parsed = new URL(origin);
      if (!LOOPBACK_HOSTNAMES.has(parsed.hostname) || parsed.host !== req.headers.host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer ([A-Za-z0-9_\-]{1,200})$/.exec(header.trim());
  return match?.[1];
}

/* ------------------------------------------------------------------ *
 * Pairing — one short-lived, single-use code at a time
 * ------------------------------------------------------------------ */

export const PAIRING_TTL_MS = 5 * 60_000;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Holds at most one pairing code, in memory only: it never touches disk,
 * dies with the process, and generating a new one invalidates the last.
 * The code is 256 bits and travels by QR, so nobody has to type it and it
 * can't be guessed — the rate limit in front of it is defence in depth.
 */
export class PairingCodes {
  private active: { hash: Buffer; expiresAt: number } | undefined;

  create(now = Date.now()): { code: string; expiresAt: number } {
    const code = randomBytes(32).toString("base64url");
    const expiresAt = now + PAIRING_TTL_MS;
    this.active = { hash: sha256(code), expiresAt };
    return { code, expiresAt };
  }

  /** Consumes the code if it matches and is still live. Single-use: a
   *  successful consume clears it. */
  consume(code: string, now = Date.now()): boolean {
    const active = this.active;
    if (!active) return false;
    if (now > active.expiresAt) {
      this.active = undefined;
      return false;
    }
    if (!timingSafeEqual(sha256(code), active.hash)) return false;
    this.active = undefined;
    return true;
  }

  cancel(): void {
    this.active = undefined;
  }
}

/** Fixed-window limiter keyed by caller. Small and in-memory on purpose:
 *  this is one person's machine, not a fleet behind a load balancer. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      if (this.hits.size > 1000) this.hits.clear();
      this.hits.set(key, { count: 1, windowStart: now });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}

/** Device names are shown back in the dashboard and the event log —
 *  strip control characters and cap the length rather than trust them. */
export function sanitizeDeviceName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, "").trim().slice(0, 64);
  return cleaned.length > 0 ? cleaned : undefined;
}

/* ------------------------------------------------------------------ *
 * Where the phone should connect
 * ------------------------------------------------------------------ */

/** Tailscale hands out addresses from the CGNAT range 100.64.0.0/10. */
export function isTailscaleAddress(address: string): boolean {
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(address);
  return m !== null && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

export type PublicUrlResult = { ok: true; url: string } | { ok: false; reason: string };

/**
 * The base URL a paired phone should use. An explicit EXEC_WEB_PUBLIC_URL
 * always wins (the `tailscale serve` HTTPS name is the recommended one —
 * iOS refuses plain HTTP by default). Otherwise, only when this server is
 * actually listening on a Tailscale address, that address is used. Never
 * guesses a LAN or public IP.
 */
export function resolvePublicUrl(args: {
  explicit: string | undefined;
  boundHost: string;
  port: number;
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>;
}): PublicUrlResult {
  if (args.explicit) {
    try {
      const url = new URL(args.explicit);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("bad protocol");
      return { ok: true, url: url.origin };
    } catch {
      return { ok: false, reason: "EXEC_WEB_PUBLIC_URL is not a valid http(s) URL." };
    }
  }

  const tailscale = Object.values(args.interfaces)
    .flat()
    .find((i) => i !== undefined && i.family === "IPv4" && isTailscaleAddress(i.address));
  const listensThere =
    tailscale !== undefined && (args.boundHost === "0.0.0.0" || args.boundHost === tailscale.address);
  if (tailscale && listensThere) return { ok: true, url: `http://${tailscale.address}:${args.port}` };

  return {
    ok: false,
    reason:
      `Your phone can't reach this dashboard yet. Run \`tailscale serve --bg ${args.port}\`, then restart the dashboard with ` +
      "`EXEC_WEB_PUBLIC_URL` set to the https://…ts.net address it prints.",
  };
}
