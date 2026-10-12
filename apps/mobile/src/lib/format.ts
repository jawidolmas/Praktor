import type { ColorValue } from 'react-native';
import type { SFSymbol } from 'expo-symbols';

import { C } from '@/constants/theme';
import type { EventKind, Host, Objective, ObjectiveStatus, TaskStatus } from '@/lib/relay';
import type { Change } from '@/lib/tree';

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

const TASK: Record<TaskStatus, StatusLook> = {
  pending: { label: 'Waiting', color: C.gray, symbol: 'circle.dotted' },
  ready: { label: 'Ready', color: C.gray, symbol: 'circle' },
  running: { label: 'Running', color: C.blue, symbol: 'bolt.circle.fill' },
  verifying: { label: 'Verifying', color: C.purple, symbol: 'checkmark.seal' },
  blocked: { label: 'Needs you', color: C.orange, symbol: 'exclamationmark.circle.fill' },
  parked: { label: 'Paused', color: C.orange, symbol: 'pause.circle.fill' },
  done: { label: 'Done', color: C.green, symbol: 'checkmark.circle.fill' },
  failed: { label: 'Failed', color: C.red, symbol: 'xmark.circle.fill' },
  abandoned: { label: 'Skipped', color: C.gray, symbol: 'minus.circle.fill' },
};

export function taskLook(status: TaskStatus): StatusLook {
  return TASK[status] ?? { label: status, color: C.gray, symbol: 'circle' };
}

const EVENT: Record<EventKind, { color: ColorValue; symbol: SFSymbol }> = {
  info: { color: C.blue, symbol: 'circle.fill' },
  success: { color: C.green, symbol: 'checkmark.circle.fill' },
  warn: { color: C.orange, symbol: 'exclamationmark.triangle.fill' },
  error: { color: C.red, symbol: 'xmark.octagon.fill' },
  muted: { color: C.gray, symbol: 'circle' },
};

export function eventLook(kind: EventKind) {
  return EVENT[kind] ?? EVENT.info;
}

/** git's change letters as a person reads them. */
export function changeLook(change: Change): { label: string; short: string; color: ColorValue } {
  switch (change) {
    case 'A':
    case 'C':
      return { label: 'Added', short: 'A', color: C.green };
    case 'D':
      return { label: 'Deleted', short: 'D', color: C.red };
    case 'R':
      return { label: 'Renamed', short: 'R', color: C.blue };
    default:
      return { label: 'Modified', short: 'M', color: C.orange };
  }
}

export function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Where an answer came from, as a phrase: "in Telegram", "from this app". */
export function answeredVia(answeredBy: string | null): string {
  const by = answeredBy ?? '';
  if (by === 'app') return 'from the app';
  if (by.startsWith('telegram')) return 'in Telegram';
  if (by === 'dashboard') return 'on the dashboard';
  if (by.includes('cli') || by.includes('terminal')) return 'in the terminal';
  return by ? `by ${by}` : '';
}

export type HostCapability = 'answers' | 'merges';

export function hostCan(host: Host, capability: HostCapability): boolean {
  return (host.capabilities ?? []).includes(capability);
}
