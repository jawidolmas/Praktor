import { useCallback, useEffect, useRef, useState } from 'react';
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
    .select('id, owner_id, name, created_at, last_seen_at, revoked_at')
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
export function useLive<T>(key: string, tables: string[], fetcher: () => Promise<T>): Live<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

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

    const channel = supabase.channel(`live:${key}`);
    for (const table of tables) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, soon);
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
    // `tables` is a constant list at every call site; keyed by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, load]);

  return { data, error, refreshing, refresh };
}
