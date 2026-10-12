import { useMemo } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { SpendChart } from '@/components/spend-chart';
import { EmptyState, Section } from '@/components/ui';
import { C, Radius, Space, Type } from '@/constants/theme';
import { money } from '@/lib/format';
import { dailySpend, peakDay, pct, spendByModel } from '@/lib/insights';
import { fetchInsights, INSIGHTS_WINDOW_DAYS, useLive } from '@/lib/relay';

function Card({ children }: { children: React.ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

function Tile({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.tile} accessible accessibilityLabel={`${label}: ${value === '—' ? 'no data yet' : value}`}>
      <Text style={styles.tileValue}>{value}</Text>
      <Text style={styles.tileLabel}>{label}</Text>
    </View>
  );
}

export default function InsightsScreen() {
  const insights = useLive('insights', ['runs', 'snapshots'], fetchInsights);
  const data = insights.data;

  const days = useMemo(() => dailySpend(data?.runs ?? [], Date.now(), INSIGHTS_WINDOW_DAYS), [data?.runs]);
  const models = useMemo(() => spendByModel(data?.runs ?? []), [data?.runs]);
  const total = days.reduce((s, d) => s + d.cost, 0);
  const activeDays = days.filter((d) => d.cost > 0).length;
  const peak = peakDay(days);
  const topModel = models[0]?.cost ?? 0;
  const health = data?.health;
  const costs = data?.costs;

  return (
    <ScrollView
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={insights.refreshing} onRefresh={insights.refresh} />}>
      {insights.error ? (
        <EmptyState symbol="wifi.exclamationmark" title="Can’t reach Praktor" message="Check your connection. Pull down to try again." />
      ) : data === undefined ? null : data.runs.length === 0 && !costs ? (
        <EmptyState
          symbol="chart.bar"
          title="Nothing to chart yet"
          message="Once your agents have run for a while, spend and health trends show up here."
        />
      ) : (
        <>
          <Text style={styles.heading}>Spend · last {INSIGHTS_WINDOW_DAYS} days</Text>
          <Card>
            <Text style={styles.hero} accessibilityRole="header">
              {money(total)}
            </Text>
            <Text style={styles.heroSub}>
              {activeDays
                ? `${activeDays} active ${activeDays === 1 ? 'day' : 'days'}${peak ? ` · busiest ${new Date(peak.start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}`
                : 'No runs in this period'}
            </Text>
            <View style={{ marginTop: Space.l }}>
              <SpendChart days={days} />
            </View>
          </Card>

          {models.length > 0 ? (
            <>
              <Text style={styles.heading}>By model · last {INSIGHTS_WINDOW_DAYS} days</Text>
              <Card>
                {models.map((m, i) => (
                  <View
                    key={m.model}
                    style={[styles.model, i > 0 && { marginTop: Space.l }]}
                    accessible
                    accessibilityLabel={`${m.model}: ${money(m.cost)} across ${m.runs} ${m.runs === 1 ? 'run' : 'runs'}`}>
                    <View style={styles.modelTop}>
                      <Text style={styles.modelName} numberOfLines={1}>
                        {m.model.replace(/^claude-/, '')}
                      </Text>
                      <Text style={styles.modelValue}>
                        {money(m.cost)} <Text style={styles.modelRuns}>· {m.runs} {m.runs === 1 ? 'run' : 'runs'}</Text>
                      </Text>
                    </View>
                    <View style={styles.track}>
                      <View style={[styles.fill, { width: `${topModel > 0 ? Math.max(1, (m.cost / topModel) * 100) : 0}%` }]} />
                    </View>
                  </View>
                ))}
              </Card>
            </>
          ) : null}

          {costs ? (
            <Section title="Where it went · all time" footer="The judge and diagnoser independently check and explain the workers’ attempts.">
              {[
                ['Workers', costs.workerCostUsd],
                ['Judge', costs.judgeCostUsd],
                ['Diagnoser', costs.diagnoserCostUsd],
              ].map(([label, value]) => (
                <View key={label as string} style={styles.split}>
                  <Text style={styles.splitLabel}>{label as string}</Text>
                  <Text style={styles.splitValue}>
                    {money(value as number)}
                    {costs.totalCostUsd > 0 ? (
                      <Text style={styles.modelRuns}> · {Math.round(((value as number) / costs.totalCostUsd) * 100)}%</Text>
                    ) : null}
                  </Text>
                </View>
              ))}
            </Section>
          ) : null}

          {health ? (
            <>
              <Text style={styles.heading}>Health · last 7 days</Text>
              <View style={styles.tiles}>
                <Tile value={pct(health.health.buildPct)} label="Checks passed" />
                <Tile value={pct(health.health.testsPct)} label="Judge accepted" />
                <Tile value={pct(health.health.securityPct)} label="Policy clean" />
              </View>
              <Section
                title={`Recovered on its own · ${health.recovered.length}`}
                footer={
                  health.recovered.length
                    ? 'Tasks that failed, were diagnosed, and finished anyway — no one had to step in.'
                    : 'Nothing has needed recovering this week.'
                }>
                {health.recovered.slice(0, 6).map((r, i) => (
                  <View key={i} style={styles.recovered}>
                    <Text style={styles.recoveredTitle} numberOfLines={2}>
                      {r.taskTitle}
                    </Text>
                    <Text style={styles.recoveredCause} numberOfLines={2}>
                      {r.class} · {r.cause}
                    </Text>
                  </View>
                ))}
              </Section>
            </>
          ) : null}
        </>
      )}
      <View style={{ height: Space.xxl * 2 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.background },
  heading: {
    ...Type.footnote,
    color: C.secondaryLabel,
    textTransform: 'uppercase',
    marginLeft: Space.l + Space.l,
    marginTop: Space.xl,
    marginBottom: Space.s - 2,
  },
  card: {
    marginHorizontal: Space.l,
    padding: Space.l + 2,
    backgroundColor: C.card,
    borderRadius: Radius.card,
    borderCurve: 'continuous',
  },
  hero: { ...Type.largeTitle, color: C.label, fontVariant: ['tabular-nums'] },
  heroSub: { ...Type.subheadline, color: C.secondaryLabel },

  model: { gap: 6 },
  modelTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: Space.m },
  modelName: { ...Type.body, color: C.label, flexShrink: 1 },
  modelValue: { ...Type.subheadline, fontWeight: '600', color: C.label, fontVariant: ['tabular-nums'] },
  modelRuns: { ...Type.footnote, fontWeight: '400', color: C.secondaryLabel },
  track: { height: 6, borderRadius: 3, backgroundColor: C.fill, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3, backgroundColor: C.tint },

  split: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: Space.l, paddingVertical: Space.m + 2 },
  splitLabel: { ...Type.body, color: C.label },
  splitValue: { ...Type.body, color: C.label, fontVariant: ['tabular-nums'] },

  tiles: { flexDirection: 'row', gap: Space.m, marginHorizontal: Space.l },
  tile: {
    flex: 1,
    padding: Space.m + 2,
    gap: 2,
    backgroundColor: C.card,
    borderRadius: Radius.control + 4,
    borderCurve: 'continuous',
  },
  tileValue: { ...Type.title2, color: C.label, fontVariant: ['tabular-nums'] },
  tileLabel: { ...Type.footnote, color: C.secondaryLabel },

  recovered: { paddingHorizontal: Space.l, paddingVertical: Space.m, gap: 2 },
  recoveredTitle: { ...Type.body, color: C.label },
  recoveredCause: { ...Type.footnote, color: C.secondaryLabel },
});
