import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * Exercises the relay's Row Level Security against real Postgres (PGlite —
 * Postgres compiled to WASM, in-process, no Docker). The pieces Supabase
 * provides around a project (auth schema, roles, realtime publication, its
 * default grants) are stubbed below with the same definitions Supabase uses,
 * and every query under test runs as the `authenticated` / `anon` role with
 * a JWT claim set, exactly like PostgREST does — so RLS is really enforced.
 */

const MIGRATIONS = join(fileURLToPath(new URL(".", import.meta.url)), "..", "migrations");

const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $$;
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
  $$;
  grant usage on schema auth to anon, authenticated;
  grant usage on schema public to anon, authenticated;
  -- Supabase's defaults: every new table and function is open to the API
  -- roles unless a migration revokes it. The tests must prove ours do.
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  create publication supabase_realtime;
`;

const OWNER_A = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER_B = "bbbbbbbb-0000-4000-8000-000000000002";
const HOST_1 = "11111111-0000-4000-8000-000000000003";
const HOST_2 = "22222222-0000-4000-8000-000000000004";

type Who = { sub: string; anonymous: boolean } | "anon";
const ownerA: Who = { sub: OWNER_A, anonymous: false };
const ownerB: Who = { sub: OWNER_B, anonymous: false };
const host1: Who = { sub: HOST_1, anonymous: true };
const host2: Who = { sub: HOST_2, anonymous: true };

let db: PGlite;

/** Runs one statement as a given caller, the way PostgREST would. */
async function as<T = Record<string, unknown>>(who: Who, sql: string, params: unknown[] = []): Promise<T[]> {
  return db.transaction(async (tx) => {
    if (who === "anon") {
      await tx.query("select set_config('request.jwt.claims', '{\"role\":\"anon\"}', true)");
      await tx.query("set local role anon");
    } else {
      const claims = JSON.stringify({ sub: who.sub, role: "authenticated", is_anonymous: who.anonymous });
      await tx.query("select set_config('request.jwt.claims', $1, true)", [claims]);
      await tx.query("set local role authenticated");
    }
    return (await tx.query<T>(sql, params)).rows;
  });
}

async function claim(host: Who, owner: Who, name = "Jawid's PC"): Promise<void> {
  const [{ code }] = await as<{ code: string }>(host, "select public.create_host_claim($1) as code", [name]);
  await as(owner, "select public.claim_host($1)", [code]);
}

const objective = (owner: string, host: string, id = "obj-1") =>
  [
    `insert into public.objectives (owner_id, host_id, id, title, repo_name, status, model, effort, created_at, updated_at)
     values ($1, $2, $3, 'Ship it', 'praktor', 'active', 'claude-sonnet-5', 'medium', 1, 1)`,
    [owner, host, id],
  ] as const;

beforeEach(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUB);
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  await db.query("insert into auth.users (id) values ($1), ($2), ($3), ($4)", [OWNER_A, OWNER_B, HOST_1, HOST_2]);
});

describe("claiming a host", () => {
  it("links a PC to the owner who redeems its code", async () => {
    await claim(host1, ownerA);
    const rows = await as(ownerA, "select id, owner_id, name from public.hosts");
    expect(rows).toEqual([{ id: HOST_1, owner_id: OWNER_A, name: "Jawid's PC" }]);
  });

  it("is single-use", async () => {
    const [{ code }] = await as<{ code: string }>(host1, "select public.create_host_claim('pc') as code");
    await as(ownerA, "select public.claim_host($1)", [code]);
    await expect(as(ownerB, "select public.claim_host($1)", [code])).rejects.toThrow(/invalid or expired/);
  });

  it("expires", async () => {
    const [{ code }] = await as<{ code: string }>(host1, "select public.create_host_claim('pc') as code");
    await db.query("update public.host_claims set expires_at = now() - interval '1 second'");
    await expect(as(ownerA, "select public.claim_host($1)", [code])).rejects.toThrow(/invalid or expired/);
  });

  it("can't be redeemed by an anonymous user (another PC)", async () => {
    const [{ code }] = await as<{ code: string }>(host1, "select public.create_host_claim('pc') as code");
    await expect(as(host2, "select public.claim_host($1)", [code])).rejects.toThrow(/sign in/);
  });

  it("rejects a wrong code", async () => {
    await as(host1, "select public.create_host_claim('pc')");
    await expect(as(ownerA, "select public.claim_host($1)", ["0".repeat(64)])).rejects.toThrow(/invalid or expired/);
  });

  it("won't issue a new code for a host that's already claimed", async () => {
    await claim(host1, ownerA);
    await expect(as(host1, "select public.create_host_claim('pc')")).rejects.toThrow(/already claimed/);
  });

  it("strips control characters from the host name and bounds its length", async () => {
    await expect(as(host1, "select public.create_host_claim($1)", ["\u0001\u0002"])).rejects.toThrow(/1-64/);
    await claim(host1, ownerA, "PC\u0007 one");
    expect((await as(ownerA, "select name from public.hosts"))[0]).toEqual({ name: "PC one" });
  });

  it("keeps claim codes unreadable to every client", async () => {
    await as(host1, "select public.create_host_claim('pc')");
    for (const who of [host1, ownerA]) {
      await expect(as(who, "select * from public.host_claims")).rejects.toThrow(/permission denied/);
    }
    await expect(as("anon", "select * from public.host_claims")).rejects.toThrow(/permission denied/);
  });

  it("stores only a hash of the code", async () => {
    const [{ code }] = await as<{ code: string }>(host1, "select public.create_host_claim('pc') as code");
    const [row] = (await db.query<{ hex: string }>("select encode(code_hash, 'hex') as hex from public.host_claims")).rows;
    expect(row!.hex).not.toContain(code);
    expect(row!.hex).toHaveLength(64);
  });
});

describe("mirror tables", () => {
  beforeEach(async () => {
    await claim(host1, ownerA);
  });

  it("let a host write into its owner's data, and the owner read it", async () => {
    await as(host1, ...objective(OWNER_A, HOST_1));
    expect(await as(ownerA, "select id from public.objectives")).toEqual([{ id: "obj-1" }]);
  });

  it("hide one owner's data from another", async () => {
    await as(host1, ...objective(OWNER_A, HOST_1));
    expect(await as(ownerB, "select id from public.objectives")).toEqual([]);
  });

  it("are read-only for the owner (a stolen phone session can't rewrite history)", async () => {
    await expect(as(ownerA, ...objective(OWNER_A, HOST_1))).rejects.toThrow(/row-level security/);
    await as(host1, ...objective(OWNER_A, HOST_1));
    await as(ownerA, "update public.objectives set title = 'tampered'");
    await as(ownerA, "delete from public.objectives");
    expect(await as(ownerA, "select title from public.objectives")).toEqual([{ title: "Ship it" }]);
  });

  it("reject a host writing into someone else's account", async () => {
    await expect(as(host1, ...objective(OWNER_B, HOST_1))).rejects.toThrow(/row-level security/);
  });

  it("reject a host stamping rows as another host", async () => {
    await claim(host2, ownerA);
    await expect(as(host1, ...objective(OWNER_A, HOST_2))).rejects.toThrow(/row-level security/);
  });

  it("stop one of an owner's hosts from overwriting another's rows", async () => {
    await claim(host2, ownerA);
    await as(host1, ...objective(OWNER_A, HOST_1));
    await as(host2, "update public.objectives set title = 'overwritten'");
    await as(host2, "delete from public.objectives");
    expect(await as(ownerA, "select title from public.objectives")).toEqual([{ title: "Ship it" }]);
  });

  it("give an unclaimed PC nothing at all", async () => {
    await as(host1, ...objective(OWNER_A, HOST_1));
    expect(await as(host2, "select id from public.objectives")).toEqual([]);
    await expect(as(host2, ...objective(OWNER_A, HOST_2))).rejects.toThrow();
  });

  it("are closed to signed-out callers", async () => {
    for (const t of ["objectives", "tasks", "runs", "events", "decisions", "agent_files", "snapshots", "hosts"]) {
      await expect(as("anon", `select * from public.${t}`)).rejects.toThrow(/permission denied/);
    }
  });

  it("cover every table in the schema with RLS", async () => {
    const rows = (
      await db.query<{ relname: string; relrowsecurity: boolean }>(
        "select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'",
      )
    ).rows;
    expect(rows.length).toBeGreaterThanOrEqual(9);
    expect(rows.filter((r) => !r.relrowsecurity)).toEqual([]);
  });

  it("keep every function away from signed-out callers", async () => {
    for (const sql of [
      "select public.create_host_claim('x')",
      "select public.claim_host('x')",
      "select public.revoke_host(gen_random_uuid())",
      "select public.host_heartbeat()",
      `select public.is_host_of('${OWNER_A}')`,
    ]) {
      await expect(as("anon", sql)).rejects.toThrow(/permission denied/);
    }
  });
});

describe("revoking a host", () => {
  beforeEach(async () => {
    await claim(host1, ownerA);
    await as(host1, ...objective(OWNER_A, HOST_1));
  });

  it("cuts off its writes and reads immediately, but keeps the owner's data", async () => {
    expect(await as(ownerA, "select public.revoke_host($1) as ok", [HOST_1])).toEqual([{ ok: true }]);
    await expect(as(host1, ...objective(OWNER_A, HOST_1, "obj-2"))).rejects.toThrow(/row-level security/);
    expect(await as(host1, "select id from public.objectives")).toEqual([]);
    expect(await as(ownerA, "select id from public.objectives")).toEqual([{ id: "obj-1" }]);
  });

  it("can only be done by the host's owner", async () => {
    expect(await as(ownerB, "select public.revoke_host($1) as ok", [HOST_1])).toEqual([{ ok: false }]);
    expect(await as(host1, "select public.revoke_host($1) as ok", [HOST_1])).toEqual([{ ok: false }]);
    expect(await as(ownerA, "select revoked_at from public.hosts")).toEqual([{ revoked_at: null }]);
  });

  it("can't be undone by the host itself", async () => {
    await as(ownerA, "select public.revoke_host($1)", [HOST_1]);
    await expect(as(host1, "update public.hosts set revoked_at = null")).rejects.toThrow(/permission denied/);
  });
});

describe("heartbeat", () => {
  it("lets a claimed host mark itself alive", async () => {
    await claim(host1, ownerA);
    await as(host1, "select public.host_heartbeat()");
    const [row] = await as<{ last_seen_at: Date | null }>(ownerA, "select last_seen_at from public.hosts");
    expect(row!.last_seen_at).not.toBeNull();
  });
});
