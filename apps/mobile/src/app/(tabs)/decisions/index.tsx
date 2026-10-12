import SegmentedControl from '@react-native-segmented-control/segmented-control';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { EmptyState, Section } from '@/components/ui';
import { C, Space, Type } from '@/constants/theme';
import { answeredVia, timeAgo } from '@/lib/format';
import { fetchDecisions, fetchReadyToMerge, useLive, type Decision, type Objective } from '@/lib/relay';

function MergeRow({ o }: { o: Objective }) {
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/objectives/[id]', params: { id: o.id } })}
      accessibilityRole="button"
      accessibilityLabel={`${o.title}. Ready to merge.`}
      accessibilityHint="Opens the objective so you can merge it"
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: C.cardPressed }]}>
      <View style={styles.rowTop}>
        <View style={styles.badge}>
          <SymbolView name="arrow.triangle.merge" size={13} tintColor={C.tint} weight="semibold" />
          <Text style={[styles.badgeText, { color: C.tint }]}>Ready to merge</Text>
        </View>
        <View style={styles.rowTrail}>
          <Text style={styles.time}>{timeAgo(o.updated_at)}</Text>
          <SymbolView name="chevron.right" size={12} tintColor={C.tertiaryLabel} weight="semibold" />
        </View>
      </View>
      <Text style={styles.title} numberOfLines={3}>
        {o.title}
      </Text>
      <Text style={styles.meta} numberOfLines={1}>
        {o.repo_name}
      </Text>
    </Pressable>
  );
}

function DecisionRow({ d }: { d: Decision }) {
  const open = d.status === 'open';
  const chosen = d.options.find((o) => o.id === d.answer)?.label ?? d.answer;
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/decisions/[id]', params: { id: d.id } })}
      accessibilityRole="button"
      accessibilityLabel={`${d.title}. ${open ? 'Waiting for you' : `Answered: ${chosen}`}.`}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: C.cardPressed }]}>
      <View style={styles.rowTop}>
        <View style={styles.badge}>
          <SymbolView
            name={open ? 'exclamationmark.bubble.fill' : 'checkmark.bubble.fill'}
            size={13}
            tintColor={open ? C.orange : C.green}
          />
          <Text style={[styles.badgeText, { color: open ? C.orange : C.green }]}>
            {open ? 'Waiting for you' : 'Answered'}
          </Text>
        </View>
        <View style={styles.rowTrail}>
          <Text style={styles.time}>{timeAgo(open ? d.created_at : (d.answered_at ?? d.created_at))}</Text>
          <SymbolView name="chevron.right" size={12} tintColor={C.tertiaryLabel} weight="semibold" />
        </View>
      </View>
      <Text style={styles.title} numberOfLines={3}>
        {d.title}
      </Text>
      {d.objective ? (
        <Text style={styles.meta} numberOfLines={1}>
          {d.objective.title} · {d.objective.repo_name}
        </Text>
      ) : null}
      {open && d.risk ? (
        <View style={styles.risk}>
          <SymbolView name="exclamationmark.triangle.fill" size={12} tintColor={C.orange} />
          <Text style={styles.riskText} numberOfLines={2}>
            {d.risk}
          </Text>
        </View>
      ) : !open && chosen ? (
        <Text style={styles.meta} numberOfLines={1}>
          “{chosen}” {answeredVia(d.answered_by)}
        </Text>
      ) : null}
    </Pressable>
  );
}

export default function Decisions() {
  const [segment, setSegment] = useState(0);
  const decisions = useLive('decisions', ['decisions'], fetchDecisions);
  const merges = useLive('ready-to-merge', ['objectives'], fetchReadyToMerge);
  const readyToMerge = merges.data ?? [];

  const waiting = useMemo(() => (decisions.data ?? []).filter((d) => d.status === 'open'), [decisions.data]);
  const answered = useMemo(() => (decisions.data ?? []).filter((d) => d.status !== 'open'), [decisions.data]);
  // Oldest question first: it has been blocking work the longest.
  const visible = segment === 0 ? [...waiting].reverse() : answered;
  const waitingCount = waiting.length + readyToMerge.length;

  return (
    <ScrollView
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={
        <RefreshControl
          refreshing={decisions.refreshing}
          onRefresh={() => {
            decisions.refresh();
            merges.refresh();
          }}
        />
      }>
      <View style={styles.segments}>
        <SegmentedControl
          values={[waitingCount ? `Waiting ${waitingCount}` : 'Waiting', 'Answered']}
          selectedIndex={segment}
          onChange={(e) => {
            Haptics.selectionAsync();
            setSegment(e.nativeEvent.selectedSegmentIndex);
          }}
        />
      </View>

      {decisions.error ? (
        <EmptyState
          symbol="wifi.exclamationmark"
          title="Can’t reach Praktor"
          message="Check your connection. Pull down to try again."
        />
      ) : decisions.data === undefined ? null : segment === 0 && waitingCount > 0 ? (
        <>
          {readyToMerge.length > 0 ? (
            <Section title="Ready to merge">
              {readyToMerge.map((o) => (
                <MergeRow key={o.id} o={o} />
              ))}
            </Section>
          ) : null}
          {visible.length > 0 ? (
            <Section title={readyToMerge.length > 0 ? 'Decisions' : undefined}>
              {visible.map((d) => (
                <DecisionRow key={d.id} d={d} />
              ))}
            </Section>
          ) : null}
        </>
      ) : visible.length === 0 ? (
        segment === 0 ? (
          <EmptyState
            symbol="checkmark.bubble"
            title="Nothing needs you"
            message="When an agent needs a decision it can’t make on its own, it shows up here."
          />
        ) : (
          <EmptyState symbol="bubble.left.and.bubble.right" title="No answers yet" message="Decisions you’ve answered collect here." />
        )
      ) : (
        <Section>
          {visible.map((d) => (
            <DecisionRow key={d.id} d={d} />
          ))}
        </Section>
      )}
      <View style={{ height: Space.xxl * 2 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.background },
  segments: { marginHorizontal: Space.l, marginTop: Space.s },
  row: { paddingHorizontal: Space.l, paddingVertical: Space.m + 2, gap: 4 },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowTrail: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  badgeText: { ...Type.footnote, fontWeight: '600' },
  time: { ...Type.footnote, color: C.tertiaryLabel },
  title: { ...Type.headline, color: C.label },
  meta: { ...Type.subheadline, color: C.secondaryLabel },
  risk: { flexDirection: 'row', gap: 6, alignItems: 'flex-start', marginTop: 2 },
  riskText: { ...Type.footnote, color: C.secondaryLabel, flex: 1 },
});
