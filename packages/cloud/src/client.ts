import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execHome } from "@exec/db";
import type { CloudConfig } from "./config.js";
import type { AnswerInbox, PendingAnswer } from "./answers.js";
import { AGENT_VERSION, HOST_CAPABILITIES } from "./capabilities.js";
import type { MergeInbox, PendingMerge } from "./merge.js";
import type { PushOutbox } from "./push.js";
import type { CloudTable, CloudWriter } from "./sync.js";

/**
 * This machine's Supabase identity: an anonymous user that becomes a "host"
 * once its owner claims it from the phone. Its session (a refresh token) is
 * kept in a file under $EXEC_HOME, inside the user's own profile directory.
 *
 * Blast radius if that file leaks: the holder can write into this host's
 * mirror rows and read its owner's mirror — never source code (sync level B),
 * never anything else in the project, and revoking the host from the phone
 * cuts it off.
 */

export function sessionPath(): string {
  return join(execHome(), "cloud-session.json");
}

/** supabase-js storage adapter over one JSON file, written atomically
 *  (temp file + rename) so a crash mid-write can't corrupt the session. */
function fileStorage(path: string) {
  const read = (): Record<string, string> => {
    try {
      return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, string>) : {};
    } catch {
      return {};
    }
  };
  const write = (data: Record<string, string>): void => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, path);
  };
  return {
    getItem: (key: string) => read()[key] ?? null,
    setItem: (key: string, value: string) => write({ ...read(), [key]: value }),
    removeItem: (key: string) => {
      const data = read();
      delete data[key];
      write(data);
    },
  };
}

export function createCloudClient(config: CloudConfig, path = sessionPath()): SupabaseClient {
  return createClient(config.url, config.key, {
    auth: {
      storage: fileStorage(path),
      storageKey: "praktor-host",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
}

/** Removes this machine's stored identity. The host row stays until the
 *  owner revokes it from the phone. */
export function forgetSession(path = sessionPath()): void {
  rmSync(path, { force: true });
}

/** Returns this machine's user id, signing in anonymously the first time. */
export async function ensureHostSession(client: SupabaseClient): Promise<string> {
  const { data } = await client.auth.getSession();
  if (data.session) return data.session.user.id;
  const signIn = await client.auth.signInAnonymously();
  if (signIn.error || !signIn.data.user) {
    throw new Error(
      `Couldn't create this PC's identity: ${signIn.error?.message ?? "no user returned"}. ` +
        "Check that anonymous sign-ins are enabled in the Supabase project (Authentication → Sign In / Providers).",
    );
  }
  return signIn.data.user.id;
}

export interface HostStatus {
  hostId: string;
  claimed: boolean;
  ownerId?: string;
  name?: string;
  revoked: boolean;
}

export async function getHostStatus(client: SupabaseClient, hostId: string): Promise<HostStatus> {
  const { data, error } = await client.from("hosts").select("owner_id, name, revoked_at").eq("id", hostId).maybeSingle();
  if (error) throw new Error(`Couldn't read host status: ${error.message}`);
  if (!data) return { hostId, claimed: false, revoked: false };
  return { hostId, claimed: true, ownerId: data.owner_id, name: data.name, revoked: data.revoked_at !== null };
}

export async function createHostClaim(client: SupabaseClient, name: string): Promise<string> {
  const { data, error } = await client.rpc("create_host_claim", { p_name: name });
  if (error || typeof data !== "string") throw new Error(`Couldn't create a claim code: ${error?.message ?? "no code"}`);
  return data;
}

/** The production CloudWriter: idempotent upserts through PostgREST, with
 *  RLS deciding what this host may write. */
export class SupabaseCloudWriter implements CloudWriter {
  constructor(private readonly client: SupabaseClient) {}

  async upsert(table: CloudTable, rows: object[], onConflict: string): Promise<void> {
    if (rows.length === 0) return;
    const { error } = await this.client.from(table).upsert(rows, { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }

  async heartbeat(): Promise<void> {
    const { error } = await this.client.rpc("host_heartbeat", {
      p_capabilities: [...HOST_CAPABILITIES],
      p_version: AGENT_VERSION,
    });
    if (error) throw new Error(`heartbeat: ${error.message}`);
  }
}

/** Answers from the phone addressed to this computer. Reads are narrowed by
 *  RLS as well as by the filter: a host can only ever see its own. */
export class SupabaseAnswerInbox implements AnswerInbox {
  constructor(
    private readonly client: SupabaseClient,
    private readonly hostId: string,
  ) {}

  async pending(): Promise<PendingAnswer[]> {
    const { data, error } = await this.client
      .from("decision_answers")
      .select("id, decision_id, decision_key, answer")
      .eq("host_id", this.hostId)
      .eq("status", "pending")
      .order("created_at")
      .limit(20);
    if (error) throw new Error(`decision_answers: ${error.message}`);
    return data as PendingAnswer[];
  }

  async settle(id: string, status: "applied" | "rejected", message: string): Promise<void> {
    const { error } = await this.client.rpc("settle_decision_answer", { p_id: id, p_status: status, p_message: message });
    if (error) throw new Error(`settle answer: ${error.message}`);
  }

  /** Calls `onNew` the moment an answer for this computer is inserted. */
  watch(onNew: () => void): () => void {
    const channel = this.client
      .channel(`answers:${this.hostId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "decision_answers", filter: `host_id=eq.${this.hostId}` },
        onNew,
      )
      .subscribe();
    return () => {
      void this.client.removeChannel(channel);
    };
  }
}

/** Merge requests from the phone addressed to this computer. */
export class SupabaseMergeInbox implements MergeInbox {
  constructor(
    private readonly client: SupabaseClient,
    private readonly hostId: string,
  ) {}

  async pending(): Promise<PendingMerge[]> {
    const { data, error } = await this.client
      .from("merge_requests")
      .select("id, objective_id")
      .eq("host_id", this.hostId)
      .eq("status", "pending")
      .order("created_at")
      .limit(10);
    if (error) throw new Error(`merge_requests: ${error.message}`);
    return data as PendingMerge[];
  }

  async settle(id: string, status: "merged" | "failed", message: string, pushed: boolean | null): Promise<void> {
    const { error } = await this.client.rpc("settle_merge_request", {
      p_id: id,
      p_status: status,
      p_message: message,
      p_pushed: pushed,
    });
    if (error) throw new Error(`settle merge: ${error.message}`);
  }

  /** Calls `onNew` the moment a merge for this computer is requested. */
  watch(onNew: () => void): () => void {
    const channel = this.client
      .channel(`merges:${this.hostId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "merge_requests", filter: `host_id=eq.${this.hostId}` },
        onNew,
      )
      .subscribe();
    return () => {
      void this.client.removeChannel(channel);
    };
  }
}

/** The owner's registered phones, as this computer is allowed to see them. */
export class SupabasePushOutbox implements PushOutbox {
  constructor(private readonly client: SupabaseClient) {}

  async tokens(): Promise<string[]> {
    const { data, error } = await this.client.from("push_devices").select("token");
    if (error) throw new Error(`push_devices: ${error.message}`);
    return (data as { token: string }[]).map((d) => d.token);
  }

  async drop(token: string): Promise<void> {
    const { error } = await this.client.rpc("drop_push_device", { p_token: token });
    if (error) throw new Error(`drop push device: ${error.message}`);
  }
}
