import type { ColorValue } from 'react-native';
import type { SFSymbol } from 'expo-symbols';

import { C } from '@/constants/theme';
import type { Host, Objective, ObjectiveStatus } from '@/lib/relay';

export interface StatusLook {
  label: string;
  color: ColorValue;
  symbol: SFSymbol;
}

const OBJECTIVE: Record<ObjectiveStatus, StatusLook> = {
  draft: { label: 'Planning', color: C.gray, symbol: 'list.bullet.indent' },
  active: { label: 'Running', color: C.blue, symbol: 'bolt.fill' },
  parked: { label: 'Paused', color: C.orange, symbol: 'pause.circle.fill' },
  blocked: { label: 'Needs you', color: C.orange, symbol: 'exclamationmark.circle.fill' },
  done: { label: 'Done', color: C.green, symbol: 'checkmark.circle.fill' },
  failed: { label: 'Failed', color: C.red, symbol: 'xmark.octagon.fill' },
  cancelled: { label: 'Cancelled', color: C.gray, symbol: 'minus.circle.fill' },
};

export function objectiveLook(o: Pick<Objective, 'status' | 'merged_at'>): StatusLook {
  if (o.status === 'done' && o.merged_at) return { label: 'Merged', color: C.purple, symbol: 'arrow.triangle.merge' };
  return OBJECTIVE[o.status] ?? { label: o.status, color: C.gray, symbol: 'circle' };
}

export type ObjectiveGroup = 'running' | 'done' | 'stopped';

export function objectiveGroup(status: ObjectiveStatus): ObjectiveGroup {
  if (status === 'done') return 'done';
  if (status === 'failed' || status === 'cancelled') return 'stopped';
  return 'running';
}

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  if (d < 7) return d === 1 ? 'yesterday' : `${d} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function money(usd: number): string {
  if (!usd) return '$0';
  if (usd < 0.01) return '<$0.01';
  return usd < 100 ? `$${usd.toFixed(2)}` : `$${Math.round(usd).toLocaleString()}`;
}

/** The daemon heartbeats every minute; a few missed beats means offline. */
const ONLINE_WITHIN_MS = 3 * 60_000;

export type HostState = 'online' | 'offline' | 'never' | 'revoked';

export function hostState(h: Host, now = Date.now()): HostState {
  if (h.revoked_at) return 'revoked';
  if (!h.last_seen_at) return 'never';
  return now - Date.parse(h.last_seen_at) <= ONLINE_WITHIN_MS ? 'online' : 'offline';
}
