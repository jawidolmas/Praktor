import { getSetting, setSetting, type Db } from "@exec/db";

/**
 * Which Supabase project this machine syncs to. Kept in the local settings
 * table (not only the environment) because the daemon is often started by
 * Task Scheduler at logon or boot, with none of the user's shell variables.
 *
 * Only a *publishable* key is ever accepted. A secret / service_role key
 * bypasses every RLS policy in the project, so it is refused outright rather
 * than stored — even if someone pastes one by mistake.
 */

export interface CloudConfig {
  url: string;
  key: string;
}

const URL_SETTING = "cloud_url";
const KEY_SETTING = "cloud_publishable_key";

export type ConfigCheck = { ok: true; config: CloudConfig } | { ok: false; reason: string };

/** Decodes a JWT's payload without verifying it — enough to read the role a
 *  legacy Supabase key claims, which is all this needs. */
function jwtRole(token: string): string | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { role?: unknown };
    return typeof parsed.role === "string" ? parsed.role : undefined;
  } catch {
    return undefined;
  }
}

export function validateCloudConfig(url: string | undefined, key: string | undefined): ConfigCheck {
  if (!url || !key) return { ok: false, reason: "Both the project URL and its publishable key are required." };

  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { ok: false, reason: "The project URL isn't a valid URL." };
  }
  if (parsed.protocol !== "https:") return { ok: false, reason: "The project URL must use https://." };

  const k = key.trim();
  if (k.startsWith("sb_secret_") || jwtRole(k) === "service_role") {
    return {
      ok: false,
      reason:
        "That's a secret (service_role) key — it bypasses every security rule in the project and must never " +
        "live on this machine. Use the publishable key (sb_publishable_…) instead.",
    };
  }
  if (!k.startsWith("sb_publishable_") && jwtRole(k) !== "anon") {
    return { ok: false, reason: "That doesn't look like a Supabase publishable key (sb_publishable_…)." };
  }

  return { ok: true, config: { url: parsed.origin, key: k } };
}

export function loadCloudConfig(db: Db): CloudConfig | undefined {
  const check = validateCloudConfig(getSetting(db, URL_SETTING), getSetting(db, KEY_SETTING));
  return check.ok ? check.config : undefined;
}

export function saveCloudConfig(db: Db, config: CloudConfig): void {
  setSetting(db, URL_SETTING, config.url);
  setSetting(db, KEY_SETTING, config.key);
}
