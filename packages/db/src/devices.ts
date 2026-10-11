import { createHash, randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { newId } from "@exec/core";
import type { Db } from "./client.js";
import { devices } from "./schema.js";
import { appendEvent } from "./store.js";

/**
 * Companion-device credentials. A device token is 256 bits from the OS CSPRNG,
 * shown once at pairing and never stored — only its SHA-256 is. Lookup is by
 * that hash through a unique index, so there's no secret-dependent string
 * comparison to time, and a stolen database copy holds nothing replayable.
 */

const TOKEN_PREFIX = "pk_";
/** Writing lastSeenAt on every request would turn every phone poll into a
 *  write; a minute of resolution is all a "last seen" column needs. */
const LAST_SEEN_RESOLUTION_MS = 60_000;

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function toInfo(row: typeof devices.$inferSelect): DeviceInfo {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    revokedAt: row.revokedAt,
  };
}

/** Registers a device and returns its bearer token — the only time the
 *  plaintext token ever exists outside the device itself. */
export function createDevice(db: Db, name: string): { device: DeviceInfo; token: string } {
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const row = {
    id: newId(),
    name,
    tokenHash: hashDeviceToken(token),
    createdAt: Date.now(),
    lastSeenAt: null,
    revokedAt: null,
  };
  db.insert(devices).values(row).run();
  appendEvent(db, { payload: { type: "device.paired", deviceId: row.id, name } });
  return { device: toInfo(row), token };
}

/** Resolves a bearer token to its device, or undefined for anything unknown
 *  or revoked. Touches lastSeenAt at most once a minute. */
export function authenticateDevice(db: Db, token: string, now = Date.now()): DeviceInfo | undefined {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 128) return undefined;
  const row = db.select().from(devices).where(eq(devices.tokenHash, hashDeviceToken(token))).get();
  if (!row || row.revokedAt !== null) return undefined;
  if (row.lastSeenAt === null || now - row.lastSeenAt >= LAST_SEEN_RESOLUTION_MS) {
    db.update(devices).set({ lastSeenAt: now }).where(eq(devices.id, row.id)).run();
    row.lastSeenAt = now;
  }
  return toInfo(row);
}

export function listDevices(db: Db): DeviceInfo[] {
  return db.select().from(devices).orderBy(desc(devices.createdAt)).all().map(toInfo);
}

/** Cuts a device off immediately — its very next request is rejected.
 *  Returns false if there was no such active device. */
export function revokeDevice(db: Db, id: string): boolean {
  const row = db.select().from(devices).where(eq(devices.id, id)).get();
  if (!row || row.revokedAt !== null) return false;
  db.update(devices).set({ revokedAt: Date.now() }).where(eq(devices.id, id)).run();
  appendEvent(db, { level: "warn", payload: { type: "device.revoked", deviceId: id, name: row.name } });
  return true;
}
