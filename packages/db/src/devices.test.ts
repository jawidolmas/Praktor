import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./client.js";
import { authenticateDevice, createDevice, hashDeviceToken, listDevices, revokeDevice } from "./devices.js";
import { runMigrations } from "./migrate.js";
import { devices } from "./schema.js";
import { readEvents } from "./store.js";

let db: Db;

beforeEach(() => {
  db = openDb({ path: ":memory:" }).db;
  runMigrations(db);
});

describe("device tokens", () => {
  it("authenticates a freshly created device by its token", () => {
    const { device, token } = createDevice(db, "Jawid's iPhone");
    expect(token).toMatch(/^pk_[A-Za-z0-9_-]{43}$/);
    expect(authenticateDevice(db, token)?.id).toBe(device.id);
  });

  it("stores only the hash, never the token itself", () => {
    const { token } = createDevice(db, "phone");
    const row = db.select().from(devices).get()!;
    expect(row.tokenHash).toBe(hashDeviceToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("rejects unknown, malformed, and revoked tokens", () => {
    const { device, token } = createDevice(db, "phone");
    expect(authenticateDevice(db, "pk_nope")).toBeUndefined();
    expect(authenticateDevice(db, token.slice(3))).toBeUndefined();
    expect(authenticateDevice(db, `pk_${"a".repeat(200)}`)).toBeUndefined();

    expect(revokeDevice(db, device.id)).toBe(true);
    expect(authenticateDevice(db, token)).toBeUndefined();
    expect(revokeDevice(db, device.id)).toBe(false);
  });

  it("gives every device a distinct token", () => {
    const a = createDevice(db, "a").token;
    const b = createDevice(db, "b").token;
    expect(a).not.toBe(b);
    expect(listDevices(db)).toHaveLength(2);
  });

  it("writes lastSeenAt at most once a minute", () => {
    const { token } = createDevice(db, "phone");
    expect(authenticateDevice(db, token, 1_000_000)?.lastSeenAt).toBe(1_000_000);
    expect(authenticateDevice(db, token, 1_030_000)?.lastSeenAt).toBe(1_000_000);
    expect(authenticateDevice(db, token, 1_060_000)?.lastSeenAt).toBe(1_060_000);
  });

  it("records pairing and revocation in the event log", () => {
    const { device } = createDevice(db, "phone");
    revokeDevice(db, device.id);
    expect(readEvents(db, {}).map((e) => e.payload.type)).toEqual(["device.paired", "device.revoked"]);
  });
});
