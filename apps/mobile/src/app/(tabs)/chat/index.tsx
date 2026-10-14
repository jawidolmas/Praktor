import { router } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, type ColorValue } from 'react-native';

import { PraktorMark } from '@/components/praktor-mark';
import { EmptyState, PrimaryButton } from '@/components/ui';
import { C, Radius, Space, Type } from '@/constants/theme';
import { groupByDay } from '@/lib/chat';
import { clockTime, objectiveLook } from '@/lib/format';
import { fetchThreads, useLive, type ThreadSummary } from '@/lib/relay';

/** The thread's current state, as a colored dot plus a word. */
function threadState(t: ThreadSummary): { label: string; color: ColorValue } {
  const { request, objective } = t.latest;
  if (request.status === 'pending') return { label: 'Sending', color: C.gray };
  if (request.status === 'rejected') return { label: 'Couldn’t start', color: C.orange };
  if (request.status === 'replied') return { label: 'Replied', color: C.gray };
  if (!objective) return { label: 'Starting', color: C.blue };
  const look = objectiveLook(objective);
  return { label: look.label, color: look.color };
}

function when(ms: number): string {
  const today = new Date().toDateString() === new Date(ms).toDateString();
  return today ? clockTime(ms) : new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function ThreadRow({ t, first }: { t: ThreadSummary; first: boolean }) {
  const state = threadState(t);
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/chat/[thread]', params: { thread: t.id } })}
      accessibilityRole="button"
      accessibilityLabel={`${t.title}. ${state.label}. ${t.repoName}.`}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: C.cardPressed }]}>
      {!first ? <View style={styles.separator} /> : null}
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.title} numberOfLines={1}>
            {t.title}
          </Text>
          <Text style={styles.time}>{when(t.lastAt)}</Text>
        </View>
        <View style={styles.meta}>
          <View style={[styles.dot, { backgroundColor: state.color }]} />
          <Text style={styles.metaText} numberOfLines={1}>
            {state.label} · {t.repoName}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

export default function Chats() {
  const threads = useLive('threads', ['requests', 'objectives'], fetchThreads);
  const groups = useMemo(() => groupByDay(threads.data ?? [], (t) => t.lastAt, Date.now()), [threads.data]);
  const newChat = () => router.push({ pathname: '/chat/[thread]', params: { thread: 'new' } });

  return (
    <ScrollView
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={threads.refreshing} onRefresh={threads.refresh} />}>
      {threads.error ? (
        <EmptyState symbol="wifi.exclamationmark" title="Can’t reach Praktor" message="Check your connection. Pull down to try again." />
      ) : threads.data === undefined ? null : threads.data.length === 0 ? (
        <View style={styles.welcome}>
          <PraktorMark size={64} />
          <Text style={styles.welcomeTitle}>What should Praktor do?</Text>
          <Text style={styles.welcomeBody}>
            Tell it in your own words. Your computer does the work — you’ll hear back here when it needs you, and when it’s
            done.
          </Text>
          <PrimaryButton title="New Chat" symbol="square.and.pencil" onPress={newChat} />
        </View>
      ) : (
        groups.map((g) => (
          <View key={g.title} style={styles.group}>
            <Text style={styles.groupTitle}>{g.title}</Text>
            <View style={styles.card}>
              {g.items.map((t, i) => (
                <ThreadRow key={t.id} t={t} first={i === 0} />
              ))}
            </View>
          </View>
        ))
      )}
      <View style={{ height: Space.xxl * 2 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.background },
  group: { marginTop: Space.xl, marginHorizontal: Space.l },
  groupTitle: { ...Type.footnote, fontWeight: '600', color: C.secondaryLabel, marginLeft: Space.l, marginBottom: Space.s - 2 },
  card: { backgroundColor: C.card, borderRadius: Radius.card, borderCurve: 'continuous', overflow: 'hidden' },
  row: { paddingHorizontal: Space.l },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: C.separator },
  rowBody: { paddingVertical: Space.m, gap: 3 },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: Space.m },
  title: { ...Type.body, color: C.label, flex: 1 },
  time: { ...Type.footnote, color: C.tertiaryLabel },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  metaText: { ...Type.footnote, color: C.secondaryLabel, flex: 1 },
  welcome: { alignItems: 'center', paddingHorizontal: Space.xxl, paddingTop: 72, gap: Space.m },
  welcomeTitle: { ...Type.title2, color: C.label, textAlign: 'center', marginTop: Space.s },
  welcomeBody: { ...Type.body, color: C.secondaryLabel, textAlign: 'center', lineHeight: 23, marginBottom: Space.m },
});

