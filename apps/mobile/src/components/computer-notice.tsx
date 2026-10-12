import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { C, Radius, Space, Type } from '@/constants/theme';
import { hostCan, hostState, type HostCapability } from '@/lib/format';
import type { Host } from '@/lib/relay';

const RESTART = 'exec-agent daemon stop; exec-agent daemon start';
/** A request still unclaimed after this long, on a computer that is online
 *  and able to handle it, gets a gentle "taking longer than usual". */
const SLOW_AFTER_MS = 90_000;

const VERB: Record<HostCapability, string> = {
  answers: 'answer decisions from your phone',
  merges: 'merge from your phone',
};

/** Re-renders every `everyMs`, so time-based messages appear on their own. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

/**
 * Says, before or while you wait, why the computer that has to act on a
 * request might not: it's offline, its Praktor is an older build that
 * can't handle this yet (it reports what it can do with every heartbeat),
 * or it simply hasn't got to it. Renders nothing when all is well.
 */
export function ComputerNotice({
  host,
  capability,
  pendingSince,
}: {
  host: Host | undefined;
  capability: HostCapability;
  /** When the request was sent, if one is waiting. */
  pendingSince?: string | null;
}) {
  const now = useNow(15_000);
  if (!host || host.revoked_at) return null;

  const state = hostState(host, now);
  let symbol: 'wifi.slash' | 'arrow.clockwise.circle.fill' | 'hourglass' | undefined;
  let title = '';
  let body: string | undefined;
  let command: string | undefined;

  if (state !== 'online') {
    symbol = 'wifi.slash';
    title = `${host.name} is offline`;
    body = pendingSince ? 'It’ll pick this up as soon as it’s back.' : 'Anything you send now is carried out when it’s back.';
  } else if (!hostCan(host, capability)) {
    symbol = 'arrow.clockwise.circle.fill';
    title = `Restart Praktor on ${host.name}`;
    body = `It’s running an older version that can’t ${VERB[capability]} yet. On that computer, run:`;
    command = RESTART;
  } else if (pendingSince && now - Date.parse(pendingSince) > SLOW_AFTER_MS) {
    symbol = 'hourglass';
    title = 'Taking longer than usual';
    body = `${host.name} is online but hasn’t picked this up yet. If it doesn’t soon, restart Praktor on it:`;
    command = RESTART;
  } else {
    return null;
  }

  return (
    <View style={styles.box} accessibilityRole="alert">
      <SymbolView name={symbol} size={18} tintColor={C.orange} />
      <View style={styles.text}>
        <Text style={styles.title}>{title}</Text>
        {body ? <Text style={styles.body}>{body}</Text> : null}
        {command ? (
          <Text style={styles.command} selectable>
            {command}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    gap: Space.s,
    alignItems: 'flex-start',
    padding: Space.m,
    borderRadius: Radius.control,
    borderCurve: 'continuous',
    backgroundColor: C.fill,
  },
  text: { flex: 1, gap: 3 },
  title: { ...Type.subheadline, fontWeight: '600', color: C.label },
  body: { ...Type.footnote, color: C.secondaryLabel },
  command: { ...Type.mono, fontSize: 12, color: C.label },
});
