import { hostname } from "node:os";
import QRCode from "qrcode";
import {
  CloudSync,
  SupabaseCloudWriter,
  createCloudClient,
  createHostClaim,
  ensureHostSession,
  forgetSession,
  getHostStatus,
  loadCloudConfig,
  saveCloudConfig,
  validateCloudConfig,
} from "@exec/cloud";
import { openDb, runMigrations } from "@exec/db";
import { parseArgs } from "./args.js";

/**
 * `exec-agent cloud …` — pairs this PC with the iOS app through the Supabase
 * relay. Pairing happens here, in a terminal, because claiming needs a person
 * present: this PC shows a single-use code, the phone (signed in with Apple)
 * scans it, and only then does the daemon start syncing.
 */

const CLAIM_TTL_MS = 10 * 60_000;
const POLL_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

const USAGE = `usage:
  exec-agent cloud connect [--name "<this PC's name>"] [--url <project-url> --key <publishable-key>]
  exec-agent cloud status
  exec-agent cloud resync
  exec-agent cloud disconnect`;

export async function runCloud(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub === "connect") return connect(rest);
  if (sub === "status") return status();
  if (sub === "resync") return resync();
  if (sub === "disconnect") return disconnect();
  console.error(USAGE);
  process.exitCode = 1;
}

function openLocalDb() {
  const { db } = openDb();
  runMigrations(db);
  return db;
}

async function connect(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  const db = openLocalDb();

  const saved = loadCloudConfig(db);
  const check = validateCloudConfig(
    flags.get("url")?.[0] ?? process.env["PRAKTOR_CLOUD_URL"] ?? saved?.url,
    flags.get("key")?.[0] ?? process.env["PRAKTOR_CLOUD_KEY"] ?? saved?.key,
  );
  if (!check.ok) {
    console.error(check.reason);
    console.error("Find both in Supabase: Project Settings → API (the URL, and the publishable key).");
    process.exitCode = 1;
    return;
  }
  saveCloudConfig(db, check.config);

  let client = createCloudClient(check.config);
  let hostId = await ensureHostSession(client);
  let current = await getHostStatus(client, hostId);

  if (current.claimed && !current.revoked) {
    console.log(`This PC is already connected as "${current.name}". The daemon syncs it automatically.`);
    return;
  }
  if (current.revoked) {
    // A revoked identity can never be reinstated (that's the point of
    // revoking it) — start over with a brand-new one.
    console.log("This PC was revoked from the app. Creating a fresh identity to pair again…");
    forgetSession();
    client = createCloudClient(check.config);
    hostId = await ensureHostSession(client);
  }

  const name = (flags.get("name")?.[0] ?? hostname()).slice(0, 64);
  const code = await createHostClaim(client, name);
  // Not a URL on purpose: the app accepts claim codes only from its own
  // scanner, so a link sent by anyone else can never claim this PC.
  const payload = `praktor-claim:v1:${code}`;
  const qr = await QRCode.toString(payload, { type: "terminal", small: true, errorCorrectionLevel: "M" });

  console.log("");
  console.log(`Pair "${name}" with the Praktor app`);
  console.log("");
  console.log("  1. Open the Praktor app on your iPhone and sign in.");
  console.log("  2. Tap \"Add a computer\" and scan this code.");
  console.log("");
  console.log(qr);
  console.log("This code works once and expires in 10 minutes. Waiting for your phone… (Ctrl-C to stop)");

  const deadline = Date.now() + CLAIM_TTL_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    try {
      current = await getHostStatus(client, hostId);
    } catch {
      continue; // a network blip while waiting isn't a reason to give up
    }
    if (current.claimed && !current.revoked) {
      console.log("");
      console.log(`Connected. "${current.name}" now syncs to your phone — the daemon picks it up within a minute.`);
      return;
    }
  }
  console.error("The code expired before it was scanned. Run `exec-agent cloud connect` again for a new one.");
  process.exitCode = 1;
}

async function status(): Promise<void> {
  const db = openLocalDb();
  const config = loadCloudConfig(db);
  if (!config) {
    console.log("Cloud sync: not set up. Run `exec-agent cloud connect`.");
    return;
  }
  console.log(`Project:  ${new URL(config.url).host}`);

  const client = createCloudClient(config);
  const { data } = await client.auth.getSession();
  if (!data.session) {
    console.log("This PC:  not connected. Run `exec-agent cloud connect`.");
    return;
  }
  const host = await getHostStatus(client, data.session.user.id);
  if (!host.claimed) console.log("This PC:  waiting to be claimed from the app.");
  else if (host.revoked) console.log(`This PC:  "${host.name}" was revoked from the app.`);
  else console.log(`This PC:  connected as "${host.name}".`);
}

async function resync(): Promise<void> {
  const db = openLocalDb();
  const config = loadCloudConfig(db);
  if (!config) {
    console.error("Cloud sync isn't set up yet. Run `exec-agent cloud connect`.");
    process.exitCode = 1;
    return;
  }
  const client = createCloudClient(config);
  const { data } = await client.auth.getSession();
  if (!data.session) {
    console.error("This PC isn't connected. Run `exec-agent cloud connect`.");
    process.exitCode = 1;
    return;
  }
  const host = await getHostStatus(client, data.session.user.id);
  if (!host.claimed || host.revoked) {
    console.error("This PC isn't an active host. Run `exec-agent cloud connect`.");
    process.exitCode = 1;
    return;
  }
  new CloudSync(db, new SupabaseCloudWriter(client), { owner_id: host.ownerId!, host_id: host.hostId }).reset();
  console.log("Everything will be re-sent to the app on the daemon's next sync.");
}

async function disconnect(): Promise<void> {
  forgetSession();
  console.log("This PC's cloud identity was removed, so it no longer syncs.");
  console.log("Its data stays visible in the app — remove the computer there to revoke it fully.");
}
