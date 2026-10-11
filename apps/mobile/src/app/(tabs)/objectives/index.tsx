import SegmentedControl from '@react-native-segmented-control/segmented-control';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { EmptyState, PrimaryButton, Section, StatusPill } from '@/components/ui';
import { C, Space, Type } from '@/constants/theme';
import { money, objectiveGroup, objectiveLook, timeAgo, type ObjectiveGroup } from '@/lib/format';
import { fetchHosts, fetchObjectives, useLive, type Objective } from '@/lib/relay';

const SEGMENTS: { key: ObjectiveGroup; label: string }[] = [
  { key: 'running', label: 'Running' },
  { key: 'done', label: 'Done' },
  { key: 'stopped', label: 'Stopped' },
];

const EMPTY: Record<ObjectiveGroup, { title: string; message: string }> = {
  running: { title: 'Nothing running', message: 'Objectives you give Praktor on your computer show up here as they run.' },
  done: { title: 'Nothing finished yet', message: 'Completed and merged work will collect here.' },
  stopped: { title: 'Nothing stopped', message: 'Failed or cancelled objectives would appear here.' },
};

function ObjectiveRow({ o }: { o: Objective }) {
  const look = objectiveLook(o);
  return (
    <View style={styles.row} accessible accessibilityLabel={`${o.title}. ${look.label}. ${o.repo_name}.`}>
      <View style={styles.rowTop}>
        <StatusPill look={look} />
        <Text style={styles.time}>{timeAgo(o.updated_at)}</Text>
      </View>
      <Text style={styles.title} numberOfLines={2}>
        {o.title}
      </Text>
      <Text style={styles.meta} numberOfLines={1}>
        {o.repo_name} · {o.model.replace(/^claude-/, '')} · {money(o.cost_usd)}
      </Text>
    </View>
  );
}

export default function Objectives() {
  const [segment, setSegment] = useState(0);
  const objectives = useLive('objectives', ['objectives'], fetchObjectives);
  const hosts = useLive('hosts', ['hosts'], fetchHosts);

  const group = SEGMENTS[segment]!.key;
  const visible = useMemo(
    () => (objectives.data ?? []).filter((o) => objectiveGroup(o.status) === group),
    [objectives.data, group],
  );
  const counts = useMemo(() => {
    const c: Record<ObjectiveGroup, number> = { running: 0, done: 0, stopped: 0 };
    for (const o of objectives.data ?? []) c[objectiveGroup(o.status)] += 1;
    return c;
  }, [objectives.data]);

  const loading = objectives.data === undefined && !objectives.error;
  const noComputer = hosts.data !== undefined && hosts.data.filter((h) => !h.revoked_at).length === 0;

  return (
    <ScrollView
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={objectives.refreshing} onRefresh={objectives.refresh} />}>
      <View style={styles.segments}>
        <SegmentedControl
          values={SEGMENTS.map((s) => (counts[s.key] ? `${s.label} ${counts[s.key]}` : s.label))}
          selectedIndex={segment}
          onChange={(e) => {
            Haptics.selectionAsync();
            setSegment(e.nativeEvent.selectedSegmentIndex);
          }}
        />
      </View>

      {objectives.error ? (
        <EmptyState
          symbol="wifi.exclamationmark"
          title="Can’t reach Praktor"
          message="Check your connection. Pull down to try again."
        />
      ) : loading ? null : noComputer ? (
        <EmptyState
          symbol="desktopcomputer"
          title="Connect your computer"
          message={'Praktor runs on your computer. Add it once, and everything it does appears here, live.'}
          action={
            <PrimaryButton title="Add a Computer" symbol="plus" onPress={() => router.push('/add-computer')} />
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState symbol="tray" title={EMPTY[group].title} message={EMPTY[group].message} />
      ) : (
        <Section>
          {visible.map((o) => (
            <ObjectiveRow key={o.id} o={o} />
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
  time: { ...Type.footnote, color: C.tertiaryLabel },
  title: { ...Type.headline, color: C.label },
  meta: { ...Type.subheadline, color: C.secondaryLabel },
});
