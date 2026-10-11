import type { IncomingMessage } from "node:http";

/**
 * The dashboard has no login. It is only safe because nothing but this
 * machine can reach it, so that has to be enforced per request rather than
 * assumed from the bind address: EXEC_WEB_HOST can be pointed at a LAN
 * interface, and a reverse proxy on loopback would hand every remote request
 * a loopback socket. Remote access goes through the Supabase relay instead,
 * never through this server.
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
