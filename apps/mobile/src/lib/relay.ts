import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { supabase } from '@/lib/supabase';

/** Row shapes of the relay tables (supabase/migrations). Timestamps on the
 *  mirror tables are epoch milliseconds; on `hosts` they're ISO strings. */

export interface Host {
  id: string;
  owner_id: string;
  name: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  /** What this computer's running Praktor can do (e.g. "answers",
   *  "merges"); empty for builds from before it reported this. */
  capabilities: string[];
  agent_version: string | null;
}

export type ObjectiveStatus = 'draft' | 'active' | 'parked' | 'blocked' | 'done' | 'failed' | 'cancelled';

export interface Objective {
  id: string;
  host_id: string;
  title: string;
  repo_name: string;
  status: ObjectiveStatus;
  model: string;
  effort: string;
  cost_usd: number;
  merged_at: number | null;
  created_at: number;
  updated_at: number;
}

export async function fetchHosts(): Promise<Host[]> {
  const { data, error } = await supabase
    .from('hosts')
    .select('id, owner_id, name, created_at, last_seen_at, revoked_at, capabilities, agent_version')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data as Host[];
}

export async function fetchObjectives(): Promise<Objective[]> {
  const { data, error } = await supabase
    .from('objectives')
    .select('id, host_id, title, repo_name, status, model, effort, cost_usd, merged_at, created_at, updated_at')
    .order('updated_at', { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return data as Objective[];
}

export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'verifying'
  | 'blocked'
  | 'parked'
  | 'done'
  | 'failed'
  | 'abandoned';

export interface Task {
  id: string;
  key: string;
  title: string;
  task_class: string;
  status: TaskStatus;
  attempts: number;
  max_attempts: number;
  depends_on: string[];
  model: string;
  created_at: number;
  updated_at: number;
}

export interface Run {
  id: string;
  task_id: string;
  attempt: number;
  model: string;
  status: string;
  exit_reason: string | null;
  turns: number;
  cost_usd: number;
  started_at: number;
  ended_at: number | null;
}

export interface DecisionOption {
  id: string;
  label: string;
  pros?: string[];
  cons?: string[];
}

export interface Decision {
  id: string;
  key: string;
  host_id: string;
  objective_id: string;
  task_id: string | null;
  level: string;
  title: string;
  context: string;
  options: DecisionOption[];
  recommendation: string;
  risk: string;
  status: string;
  answer: string | null;
  answered_by: string | null;
  answered_at: number | null;
  created_at: number;
  /** Embedded from the objectives table on list/detail reads. */
  objective?: { title: string; repo_name: string } | null;
}

export interface DecisionAnswer {
  id: string;
  decision_id: string;
  answer: string;
  status: 'pending' | 'applied' | 'rejected';
  message: string | null;
  created_at: string;
  settled_at: string | null;
}

const DECISION_COLUMNS =
  'id, key, host_id, objective_id, task_id, level, title, context, options, recommendation, risk, status, answer, answered_by, answered_at, created_at';

export async function fetchDecisions(): Promise<Decision[]> {
  const result = await supabase
    .from('decisions')
    .select(`${DECISION_COLUMNS}, objective:objectives(title, repo_name)`)
    .order('created_at', { ascending: false })
    .limit(200);
  return unwrap(result) as unknown as Decision[];
}

export interface DecisionDetail {
  decision: Decision;
  answer: DecisionAnswer | null;
}

export async function fetchDecision(id: string): Promise<DecisionDetail | null> {
  const [decision, answer] = await Promise.all([
    supabase
      .from('decisions')
      .select(`${DECISION_COLUMNS}, objective:objectives(title, repo_name)`)
      .eq('id', id)
      .maybeSingle(),
    supabase
      .from('decision_answers')
      .select('id, decision_id, answer, status, message, created_at, settled_at')
      .eq('decision_id', id)
      .maybeSingle(),
  ]);
  const d = unwrap(decision);
  if (!d) return null;
  return { decision: d as unknown as Decision, answer: (unwrap(answer) as DecisionAnswer | null) ?? null };
}

/** Sends an answer; idempotent server-side, so a retry is always safe. */
export async function sendDecisionAnswer(decisionId: string, option: string): Promise<DecisionAnswer> {
  const { data, error } = await supabase.rpc('answer_decision', { p_decision_id: decisionId, p_answer: option });
  if (error) throw new Error(error.message);
  return data as DecisionAnswer;
}

export interface AgentFile {
  task_id: string;
  path: string;
  attempt: number;
  change: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X';
  old_path: string | null;
}

export type EventKind = 'info' | 'success' | 'warn' | 'error' | 'muted';

export interface ActivityEvent {
  id: number;
  host_id: string;
  task_id: string | null;
  ts: number;
  type: string;
  kind: EventKind;
  text: string;
  model: string | null;
}

export interface ObjectiveDetail {
  objective: Objective;
  tasks: Task[];
  runs: Run[];
  decisions: Decision[];
  files: AgentFile[];
}

function unwrap<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data as T;
}

/** Everything about one objective except its activity log, in parallel. */
export async function fetchObjectiveDetail(id: string): Promise<ObjectiveDetail | null> {
  const [objective, tasks, runs, decisions, files] = await Promise.all([
    supabase
      .from('objectives')
      .select('id, host_id, title, repo_name, status, model, effort, cost_usd, merged_at, created_at, updated_at')
      .eq('id', id)
      .maybeSingle(),
    supabase
      .from('tasks')
      .select('id, key, title, task_class, status, attempts, max_attempts, depends_on, model, created_at, updated_at')
      .eq('objective_id', id)
      .order('key'),
    supabase
      .from('runs')
      .select('id, task_id, attempt, model, status, exit_reason, turns, cost_usd, started_at, ended_at')
      .eq('objective_id', id)
      .order('started_at'),
    supabase
      .from('decisions')
      .select(DECISION_COLUMNS)
      .eq('objective_id', id)
      .order('created_at', { ascending: false }),
    supabase
      .from('agent_files')
      .select('task_id, path, attempt, change, old_path')
      .eq('objective_id', id)
      .limit(5000),
  ]);
  const o = unwrap(objective);
  if (!o) return null;
  return {
    objective: o as Objective,
    tasks: unwrap(tasks) as Task[],
    runs: unwrap(runs) as Run[],
    decisions: unwrap(decisions) as Decision[],
    files: unwrap(files) as AgentFile[],
  };
}

/** The objective's activity log, newest first. */
export async function fetchObjectiveEvents(id: string): Promise<ActivityEvent[]> {
  const result = await supabase
    .from('events')
    .select('id, host_id, task_id, ts, type, kind, text, model')
    .eq('objective_id', id)
    .order('ts', { ascending: false })
    .order('id', { ascending: false })
    .limit(300);
  return unwrap(result) as ActivityEvent[];
}

/** Claims the computer showing `code`. Returns the new host's id. */
export async function claimHost(code: string): Promise<string> {
  const { data, error } = await supabase.rpc('claim_host', { p_code: code });
  if (error) throw new Error(error.message);
  return data as string;
}

export async function revokeHost(id: string): Promise<void> {
  const { error } = await supabase.rpc('revoke_host', { p_host: id });
  if (error) throw new Error(error.message);
}

export interface Live<T> {
  data: T | undefined;
  error: string | undefined;
  refreshing: boolean;
  refresh: () => Promise<void>;
}

/**
 * Loads `fetcher` and keeps it current: Supabase Realtime pushes a change on
 * any of `tables` (filtered server-side by the same RLS rules), and the data
 * is re-read when the app comes back to the foreground, since a suspended
 * app misses realtime messages. Bursts of changes are coalesced so a busy
 * agent doesn't trigger a reload per event.
 */
/** A table to watch, optionally narrowed server-side (Realtime filter
 *  syntax, e.g. `objective_id=eq.<id>`) so a busy table doesn't wake
 *  screens that don't care. */
export type Watch = string | { table: string; filter: string };

export function useLive<T>(key: string, tables: Watch[], fetcher: () => Promise<T>): Live<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const instance = useId();

  const load = useCallback(async () => {
    try {
      setData(await fetcherRef.current());
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  useEffect(() => {
    load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 400);
    };

    // supabase-js hands back the *same* channel for a repeated name, so two
    // screens watching one table would share — and tear down — each other's
    // subscription. Every hook instance gets its own.
    const channel = supabase.channel(`live:${key}:${instance}`);
    for (const watch of tables) {
      const spec = typeof watch === 'string' ? { table: watch } : watch;
      channel.on('postgres_changes', { event: '*', schema: 'public', ...spec }, soon);
    }
    channel.subscribe();

    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') load();
    });

    return () => {
      clearTimeout(timer);
      appState.remove();
      supabase.removeChannel(channel);
    };
    // `tables` is fixed per `key` at every call site, so `key` stands in for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, instance, load]);

  // Coming back to a screen (say, after adding a computer in the sheet)
  // re-reads, rather than trusting what was on screen before it was covered.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  return { data, error, refreshing, refresh };
}

export interface MergeRequest {
  id: string;
  objective_id: string;
  status: 'pending' | 'merged' | 'failed';
  message: string | null;
  pushed: boolean | null;
  created_at: string;
  settled_at: string | null;
}

/** The most recent merge request for an objective, if any. */
export async function fetchMergeRequest(objectiveId: string): Promise<MergeRequest | null> {
  const result = await supabase
    .from('merge_requests')
    .select('id, objective_id, status, message, pushed, created_at, settled_at')
    .eq('objective_id', objectiveId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (unwrap(result) as MergeRequest | null) ?? null;
}

/** Asks the computer that ran it to merge and push. Idempotent while a
 *  request is pending, so a retry is always safe. */
export async function requestMerge(objectiveId: string): Promise<MergeRequest> {
  const { data, error } = await supabase.rpc('request_merge', { p_objective_id: objectiveId });
  if (error) throw new Error(error.message);
  return data as MergeRequest;
}

/** Finished work still waiting for a merge — recent only, so long-finished
 *  objectives that were never meant to be merged don't pile up as to-dos. */
export const READY_TO_MERGE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export async function fetchReadyToMerge(): Promise<Objective[]> {
  const result = await supabase
    .from('objectives')
    .select('id, host_id, title, repo_name, status, model, effort, cost_usd, merged_at, created_at, updated_at')
    .eq('status', 'done')
    .is('merged_at', null)
    .gte('updated_at', Date.now() - READY_TO_MERGE_WINDOW_MS)
    .order('updated_at', { ascending: false });
  return unwrap(result) as Objective[];
}

export interface HealthSnapshot {
  health: { buildPct?: number; testsPct?: number; securityPct?: number };
  recovered: { taskTitle: string; objectiveTitle: string; cause: string; class: string }[];
  windowMs: number;
}

export interface CostSnapshot {
  totalCostUsd: number;
  workerCostUsd: number;
  judgeCostUsd: number;
  diagnoserCostUsd: number;
}

export interface Insights {
  runs: { started_at: number; cost_usd: number; model: string }[];
  /** Summed across computers. */
  costs: CostSnapshot | null;
  /** The most recently updated computer's view. */
  health: HealthSnapshot | null;
}

export const INSIGHTS_WINDOW_DAYS = 30;

export async function fetchInsights(): Promise<Insights> {
  const since = Date.now() - INSIGHTS_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const [runs, snapshots] = await Promise.all([
    supabase.from('runs').select('started_at, cost_usd, model').gte('started_at', since).limit(10000),
    supabase.from('snapshots').select('kind, data, updated_at').in('kind', ['costs', 'health']).order('updated_at', { ascending: false }),
  ]);
  const snaps = unwrap(snapshots) as { kind: string; data: unknown; updated_at: number }[];

  const costRows = snaps.filter((x) => x.kind === 'costs').map((x) => x.data as Partial<CostSnapshot>);
  const sum = (field: keyof CostSnapshot) => costRows.reduce((total, c) => total + (c[field] ?? 0), 0);
  const costs: CostSnapshot | null = costRows.length
    ? {
        totalCostUsd: sum('totalCostUsd'),
        workerCostUsd: sum('workerCostUsd'),
        judgeCostUsd: sum('judgeCostUsd'),
        diagnoserCostUsd: sum('diagnoserCostUsd'),
      }
    : null;
  const health = (snaps.find((x) => x.kind === 'health')?.data as HealthSnapshot | undefined) ?? null;

  return { runs: unwrap(runs) as Insights['runs'], costs, health };
}

export interface Repo {
  host_id: string;
  key: string;
  name: string;
  last_used_at: number | null;
}

export async function fetchRepos(): Promise<Repo[]> {
  const result = await supabase.from('repos').select('host_id, key, name, last_used_at').order('name');
  return unwrap(result) as Repo[];
}

export interface ChatRequest {
  id: string;
  thread_id: string;
  host_id: string;
  repo_key: string;
  repo_name: string;
  message: string;
  status: 'pending' | 'started' | 'rejected';
  objective_id: string | null;
  reason: string | null;
  created_at: string;
}

const REQUEST_COLUMNS = 'id, thread_id, host_id, repo_key, repo_name, message, status, objective_id, reason, created_at';
const OBJECTIVE_COLUMNS = 'id, host_id, title, repo_name, status, model, effort, cost_usd, merged_at, created_at, updated_at';

export interface ThreadSummary {
  id: string;
  title: string;
  lastAt: number;
  repoName: string;
  hostId: string;
  /** The newest request, with its objective once the computer started one. */
  latest: { request: ChatRequest; objective?: Objective };
}

/** Every conversation, newest activity first, named by its first message. */
export async function fetchThreads(): Promise<ThreadSummary[]> {
  const requests = unwrap(
    await supabase.from('requests').select(REQUEST_COLUMNS).order('created_at', { ascending: true }).limit(1000),
  ) as ChatRequest[];
  const threads = new Map<string, ChatRequest[]>();
  for (const r of requests) threads.set(r.thread_id, [...(threads.get(r.thread_id) ?? []), r]);

  const latestIds = [...threads.values()]
    .map((rs) => rs[rs.length - 1]!.objective_id)
    .filter((x): x is string => !!x);
  const objectives = latestIds.length
    ? (unwrap(await supabase.from('objectives').select(OBJECTIVE_COLUMNS).in('id', latestIds)) as Objective[])
    : [];
  const byId = new Map(objectives.map((o) => [o.id, o] as const));

  return [...threads.entries()]
    .map(([id, rs]) => {
      const last = rs[rs.length - 1]!;
      const objective = last.objective_id ? byId.get(last.objective_id) : undefined;
      return {
        id,
        title: rs[0]!.message.split(/\r?\n/)[0]!.slice(0, 120),
        lastAt: Math.max(Date.parse(last.created_at), objective?.updated_at ?? 0),
        repoName: last.repo_name,
        hostId: last.host_id,
        latest: { request: last, ...(objective ? { objective } : {}) },
      };
    })
    .sort((a, b) => b.lastAt - a.lastAt);
}

export interface ThreadItem {
  request: ChatRequest;
  objective?: Objective;
  tasks: Task[];
  decisions: Decision[];
  merge?: MergeRequest;
  /** The latest error or warning line, to explain a failure. */
  problem?: string;
}

/** One conversation: each request with everything about the objective it started. */
export async function fetchThread(threadId: string): Promise<ThreadItem[]> {
  const requests = unwrap(
    await supabase.from('requests').select(REQUEST_COLUMNS).eq('thread_id', threadId).order('created_at'),
  ) as ChatRequest[];
  const ids = requests.map((r) => r.objective_id).filter((x): x is string => !!x);
  if (ids.length === 0) return requests.map((request) => ({ request, tasks: [], decisions: [] }));

  const [objectives, tasks, decisions, merges, problems] = await Promise.all([
    supabase.from('objectives').select(OBJECTIVE_COLUMNS).in('id', ids),
    supabase
      .from('tasks')
      .select('id, objective_id, key, title, task_class, status, attempts, max_attempts, depends_on, model, created_at, updated_at')
      .in('objective_id', ids)
      .order('key'),
    supabase.from('decisions').select(DECISION_COLUMNS).in('objective_id', ids).order('created_at'),
    supabase
      .from('merge_requests')
      .select('id, objective_id, status, message, pushed, created_at, settled_at')
      .in('objective_id', ids)
      .order('created_at', { ascending: false }),
    supabase
      .from('events')
      .select('objective_id, text, kind, ts')
      .in('objective_id', ids)
      .in('kind', ['error', 'warn'])
      .order('ts', { ascending: false })
      .limit(50),
  ]);
  const objectiveRows = unwrap(objectives) as Objective[];
  const taskRows = unwrap(tasks) as (Task & { objective_id: string })[];
  const decisionRows = unwrap(decisions) as Decision[];
  const mergeRows = unwrap(merges) as MergeRequest[];
  const problemRows = unwrap(problems) as { objective_id: string; text: string }[];

  return requests.map((request) => {
    const id = request.objective_id;
    const objective = id ? objectiveRows.find((o) => o.id === id) : undefined;
    const merge = id ? mergeRows.find((m) => m.objective_id === id) : undefined;
    const problem = id ? problemRows.find((p) => p.objective_id === id)?.text : undefined;
    return {
      request,
      ...(objective ? { objective } : {}),
      tasks: id ? taskRows.filter((t) => t.objective_id === id) : [],
      decisions: id ? decisionRows.filter((d) => d.objective_id === id) : [],
      ...(merge ? { merge } : {}),
      ...(problem ? { problem } : {}),
    };
  });
}

/** Sends a message. Idempotent on `id` server-side: retrying never starts
 *  the work twice. */
export async function sendRequest(args: {
  id: string;
  threadId: string;
  hostId: string;
  repoKey: string;
  message: string;
}): Promise<ChatRequest> {
  const { data, error } = await supabase.rpc('send_request', {
    p_id: args.id,
    p_thread_id: args.threadId,
    p_host_id: args.hostId,
    p_repo_key: args.repoKey,
    p_message: args.message,
  });
  if (error) throw new Error(error.message);
  return data as ChatRequest;
}
