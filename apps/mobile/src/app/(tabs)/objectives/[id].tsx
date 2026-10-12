import SegmentedControl from '@react-native-segmented-control/segmented-control';
import * as Haptics from 'expo-haptics';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { FileTree } from '@/components/file-tree';
import { EmptyState, Section, StatusPill } from '@/components/ui';
import { C, Radius, Space, Type } from '@/constants/theme';
import {
  changeLook,
  clockTime,
  duration,
  eventLook,
  money,
  objectiveLook,
  taskLook,
  timeAgo,
} from '@/lib/format';
import {
  fetchHosts,
  fetchObjectiveDetail,
  fetchObjectiveEvents,
  useLive,
  type ActivityEvent,
  type Decision,
  type ObjectiveDetail,
  type Run,
  type Task,
} from '@/lib/relay';
import { buildTree, mergeByPath, summarize } from '@/lib/tree';

const TABS = ['Tasks', 'Files', 'Activity'] as const;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function Hero({ detail, computer }: { detail: ObjectiveDetail; computer?: string }) {
  const o = detail.objective;
  const look = objectiveLook(o);
  const done = detail.tasks.filter((t) => t.status === 'done').length;
  const finished = o.status === 'done' || o.status === 'failed' || o.status === 'cancelled';
  const elapsed = (finished ? o.updated_at : Date.now()) - o.created_at;

  return (
    <View style={styles.hero}>
      <View style={styles.heroTop}>
        <StatusPill look={look} />
        <Text style={styles.muted}>{timeAgo(o.updated_at)}</Text>
      </View>
      <Text style={styles.heroTitle} accessibilityRole="header">
        {o.title}
      </Text>
      <Text style={styles.heroMeta} numberOfLines={2}>
        {[computer, o.repo_name, o.model.replace(/^claude-/, ''), `${o.effort} effort`].filter(Boolean).join(' · ')}
      </Text>
      <View style={styles.stats}>
        <Stat label="Cost" value={money(o.cost_usd)} />
        <View style={styles.statDivider} />
        <Stat label="Tasks" value={detail.tasks.length ? `${done}/${detail.tasks.length}` : '—'} />
        <View style={styles.statDivider} />
        <Stat label="Attempts" value={String(detail.runs.length)} />
        <View style={styles.statDivider} />
        <Stat label={finished ? 'Took' : 'Running'} value={duration(elapsed)} />
      </View>
    </View>
  );
}

function NeedsYou({ decisions }: { decisions: Decision[] }) {
  if (decisions.length === 0) return null;
  return (
    <View style={styles.needs} accessibilityRole="alert">
      <View style={styles.needsHead}>
        <SymbolView name="exclamationmark.bubble.fill" size={20} tintColor={C.orange} />
        <Text style={styles.needsTitle}>
          {decisions.length === 1 ? 'Waiting for your decision' : `${decisions.length} decisions waiting`}
        </Text>
      </View>
      {decisions.map((d) => (
        <Pressable
          key={d.id}
          onPress={() => router.push({ pathname: '/decisions/[id]', params: { id: d.id } })}
          accessibilityRole="button"
          accessibilityHint="Opens the decision so you can answer it"
          style={({ pressed }) => [styles.needsItem, pressed && { opacity: 0.6 }]}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.needsItemTitle}>
              {d.key} · {d.title}
            </Text>
            {d.risk ? (
              <Text style={styles.needsRisk} numberOfLines={3}>
                Risk: {d.risk}
              </Text>
            ) : null}
          </View>
          <SymbolView name="chevron.right" size={12} tintColor={C.tertiaryLabel} weight="semibold" />
        </Pressable>
      ))}
    </View>
  );
}

function TaskList({ tasks, runs }: { tasks: Task[]; runs: Run[] }) {
  const costByTask = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of runs) m.set(r.task_id, (m.get(r.task_id) ?? 0) + r.cost_usd);
    return m;
  }, [runs]);

  if (tasks.length === 0) {
    return (
      <EmptyState
        symbol="list.bullet.rectangle"
        title="Planning"
        message="Praktor is breaking this objective into tasks. They’ll appear here in a moment."
      />
    );
  }
  return (
    <Section>
      {tasks.map((t) => {
        const look = taskLook(t.status);
        const attempts = t.attempts > 0 ? `attempt ${t.attempts} of ${t.max_attempts}` : 'not started';
        return (
          <View
            key={t.id}
            style={styles.task}
            accessible
            accessibilityLabel={`${t.title}. ${look.label}. ${attempts}.`}>
            <SymbolView name={look.symbol} size={22} tintColor={look.color} />
            <View style={styles.taskText}>
              <Text style={styles.taskTitle} numberOfLines={3}>
                {t.title}
              </Text>
              <Text style={styles.taskMeta} numberOfLines={1}>
                <Text style={{ color: look.color }}>{look.label}</Text>
                {` · ${attempts} · ${t.model.replace(/^claude-/, '')} · ${money(costByTask.get(t.id) ?? 0)}`}
              </Text>
            </View>
            <Text style={styles.taskKey}>{t.key}</Text>
          </View>
        );
      })}
    </Section>
  );
}

function Files({ detail }: { detail: ObjectiveDetail }) {
  const merged = useMemo(() => mergeByPath(detail.files), [detail.files]);
  const tree = useMemo(() => buildTree(merged), [merged]);
  const s = useMemo(() => summarize(merged), [merged]);

  if (merged.length === 0) {
    return (
      <EmptyState
        symbol="folder"
        title="No files changed yet"
        message="As agents create and edit files, the tree they build shows up here."
      />
    );
  }
  const chips = [
    { n: s.added, ...changeLook('A') },
    { n: s.modified, ...changeLook('M') },
    { n: s.deleted, ...changeLook('D') },
    { n: s.renamed, ...changeLook('R') },
  ].filter((c) => c.n > 0);

  return (
    <View style={styles.filesWrap}>
      <View style={styles.chips}>
        <Text style={styles.chipsTotal}>
          {s.total} {s.total === 1 ? 'file' : 'files'}
        </Text>
        {chips.map((c) => (
          <View key={c.short} style={styles.chip}>
            <View style={[styles.chipDot, { backgroundColor: c.color }]} />
            <Text style={styles.chipText}>
              {c.n} {c.label.toLowerCase()}
            </Text>
          </View>
        ))}
      </View>
      <FileTree tree={tree} total={merged.length} />
      <Text style={styles.footnote}>Names only — file contents never leave your computer.</Text>
    </View>
  );
}

function Activity({ events }: { events: ActivityEvent[] | undefined; }) {
  if (events === undefined) return <ActivityIndicator style={{ marginTop: Space.xxl }} />;
  if (events.length === 0) {
    return <EmptyState symbol="text.bubble" title="No activity yet" message="What the agents do appears here, live." />;
  }
  const today = new Date().toDateString();
  return (
    <Section>
      {events.map((e) => {
        const look = eventLook(e.kind);
        const when =
          new Date(e.ts).toDateString() === today
            ? clockTime(e.ts)
            : `${new Date(e.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${clockTime(e.ts)}`;
        return (
          <View key={`${e.host_id}:${e.id}`} style={styles.event}>
            <View style={styles.eventIcon}>
              <SymbolView name={look.symbol} size={13} tintColor={look.color} />
            </View>
            <View style={styles.eventText}>
              <Text style={[styles.eventBody, e.kind === 'muted' && { color: C.secondaryLabel }]}>{e.text}</Text>
              <Text style={styles.eventMeta}>
                {[when, e.model?.replace(/^claude-/, '')].filter(Boolean).join(' · ')}
              </Text>
            </View>
          </View>
        );
      })}
    </Section>
  );
}

export default function ObjectiveScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [tab, setTab] = useState(0);

  const detail = useLive(
    `objective:${id}`,
    [
      { table: 'objectives', filter: `id=eq.${id}` },
      { table: 'tasks', filter: `objective_id=eq.${id}` },
      { table: 'runs', filter: `objective_id=eq.${id}` },
      { table: 'decisions', filter: `objective_id=eq.${id}` },
      { table: 'agent_files', filter: `objective_id=eq.${id}` },
    ],
    () => fetchObjectiveDetail(id),
  );
  const events = useLive(
    `events:${id}`,
    [{ table: 'events', filter: `objective_id=eq.${id}` }],
    () => fetchObjectiveEvents(id),
  );
  const hosts = useLive('hosts', ['hosts'], fetchHosts);

  const d = detail.data;
  const computer = useMemo(() => {
    if (!d || !hosts.data || hosts.data.length < 2) return undefined;
    return hosts.data.find((h) => h.id === d.objective.host_id)?.name;
  }, [d, hosts.data]);
  const openDecisions = (d?.decisions ?? []).filter((x) => x.status === 'open');
  const fileCount = d ? mergeByPath(d.files).length : 0;

  return (
    <>
      <Stack.Screen options={{ title: d?.objective.repo_name ?? '' }} />
      <ScrollView
        style={styles.screen}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={
          <RefreshControl
            refreshing={detail.refreshing}
            onRefresh={() => {
              detail.refresh();
              events.refresh();
            }}
          />
        }>
        {detail.error ? (
          <EmptyState
            symbol="wifi.exclamationmark"
            title="Can’t reach Praktor"
            message="Check your connection. Pull down to try again."
          />
        ) : d === undefined ? (
          <ActivityIndicator style={{ marginTop: 80 }} />
        ) : d === null ? (
          <EmptyState
            symbol="questionmark.folder"
            title="Objective not found"
            message="It may belong to a computer you removed, or it hasn’t synced yet."
          />
        ) : (
          <>
            <Hero detail={d} computer={computer} />
            <NeedsYou decisions={openDecisions} />
            <View style={styles.tabs}>
              <SegmentedControl
                values={[
                  d.tasks.length ? `Tasks ${d.tasks.length}` : 'Tasks',
                  fileCount ? `Files ${fileCount}` : 'Files',
                  'Activity',
                ]}
                selectedIndex={tab}
                onChange={(e) => {
                  Haptics.selectionAsync();
                  setTab(e.nativeEvent.selectedSegmentIndex);
                }}
              />
            </View>
            {TABS[tab] === 'Tasks' ? (
              <TaskList tasks={d.tasks} runs={d.runs} />
            ) : TABS[tab] === 'Files' ? (
              <Files detail={d} />
            ) : (
              <Activity events={events.data} />
            )}
          </>
        )}
        <View style={{ height: Space.xxl * 2 }} />
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.background },
  muted: { ...Type.footnote, color: C.tertiaryLabel },

  hero: {
    marginHorizontal: Space.l,
    marginTop: Space.m,
    padding: Space.l + 2,
    gap: Space.s,
    backgroundColor: C.card,
    borderRadius: Radius.card,
    borderCurve: 'continuous',
  },
  heroTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heroTitle: { ...Type.title2, color: C.label },
  heroMeta: { ...Type.subheadline, color: C.secondaryLabel },
  stats: {
    flexDirection: 'row',
    marginTop: Space.s,
    paddingTop: Space.m,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.separator,
  },
  stat: { flex: 1, alignItems: 'center', gap: 2 },
  statValue: { ...Type.headline, color: C.label, fontVariant: ['tabular-nums'] },
  statLabel: { ...Type.caption, color: C.secondaryLabel },
  statDivider: { width: StyleSheet.hairlineWidth, backgroundColor: C.separator, marginVertical: 2 },

  needs: {
    marginHorizontal: Space.l,
    marginTop: Space.m,
    padding: Space.l,
    gap: Space.s,
    borderRadius: Radius.card,
    borderCurve: 'continuous',
    backgroundColor: C.card,
    borderWidth: 1.5,
    borderColor: C.orange,
  },
  needsHead: { flexDirection: 'row', alignItems: 'center', gap: Space.s },
  needsTitle: { ...Type.headline, color: C.label },
  needsItem: { flexDirection: 'row', alignItems: 'center', gap: Space.s, paddingVertical: 2 },
  needsItemTitle: { ...Type.subheadline, fontWeight: '600', color: C.label },
  needsRisk: { ...Type.footnote, color: C.secondaryLabel },

  tabs: { marginHorizontal: Space.l, marginTop: Space.xl },

  task: { flexDirection: 'row', alignItems: 'center', gap: Space.m, paddingHorizontal: Space.l, paddingVertical: Space.m },
  taskText: { flex: 1, gap: 2 },
  taskTitle: { ...Type.body, color: C.label },
  taskMeta: { ...Type.footnote, color: C.secondaryLabel },
  taskKey: { ...Type.caption, fontFamily: 'Menlo', color: C.tertiaryLabel },

  filesWrap: { marginHorizontal: Space.l, marginTop: Space.l, gap: Space.m },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: Space.s + 2 },
  chipsTotal: { ...Type.subheadline, fontWeight: '600', color: C.label, marginRight: 2 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  chipDot: { width: 8, height: 8, borderRadius: 4 },
  chipText: { ...Type.footnote, color: C.secondaryLabel },
  footnote: { ...Type.footnote, color: C.tertiaryLabel, textAlign: 'center' },

  event: { flexDirection: 'row', gap: Space.m, paddingHorizontal: Space.l, paddingVertical: Space.m - 2 },
  eventIcon: { width: 16, paddingTop: 3, alignItems: 'center' },
  eventText: { flex: 1, gap: 2 },
  eventBody: { ...Type.subheadline, color: C.label },
  eventMeta: { ...Type.caption, color: C.tertiaryLabel },
});
