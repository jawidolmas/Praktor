import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { C, Space, Type } from '@/constants/theme';
import { money } from '@/lib/format';
import { peakDay, type DaySpend } from '@/lib/insights';

const HEIGHT = 132;

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function longDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * Daily spend as a single-series bar chart: one hue (the title names the
 * series, so no legend), thin bars with rounded data-ends anchored to one
 * recessive baseline, a 2px gap between bars, and only three date labels.
 * Tapping a day — the whole column is the target, not just the bar — reads
 * its exact value out above the chart in text ink.
 */
export function SpendChart({ days }: { days: DaySpend[] }) {
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const max = Math.max(...days.map((d) => d.cost), 0);
  const peak = peakDay(days);
  const total = days.reduce((s, d) => s + d.cost, 0);
  const pick = selected !== undefined ? days[selected] : undefined;

  const summary = `Spend over the last ${days.length} days: ${money(total)} in total${
    peak ? `, highest on ${longDate(peak.start)} at ${money(peak.cost)}` : ''
  }.`;

  return (
    <View accessibilityLabel={summary}>
      <Text style={styles.readout} accessibilityLiveRegion="polite">
        {pick ? (
          <>
            <Text style={styles.readoutStrong}>{money(pick.cost)}</Text> on {longDate(pick.start)}
          </>
        ) : (
          'Tap a day to see what it cost'
        )}
      </Text>

      <View style={styles.plot}>
        {max > 0 ? <Text style={styles.maxLabel}>{money(max)}</Text> : null}
        <View style={styles.maxLine} />
        <View style={styles.bars}>
          {days.map((d, i) => {
            const h = max > 0 && d.cost > 0 ? Math.max(2, (d.cost / max) * (HEIGHT - 18)) : 0;
            const dimmed = selected !== undefined && selected !== i;
            return (
              <Pressable
                key={d.key}
                style={styles.column}
                onPress={() => {
                  Haptics.selectionAsync();
                  setSelected(selected === i ? undefined : i);
                }}
                accessibilityRole="button"
                accessibilityLabel={`${longDate(d.start)}: ${money(d.cost)}`}
                accessibilityState={{ selected: selected === i }}>
                <View style={[styles.bar, { height: h, opacity: dimmed ? 0.35 : 1 }]} />
              </Pressable>
            );
          })}
        </View>
        <View style={styles.baseline} />
      </View>

      <View style={styles.axis}>
        <Text style={styles.axisLabel}>{shortDate(days[0]!.start)}</Text>
        <Text style={styles.axisLabel}>{shortDate(days[Math.floor(days.length / 2)]!.start)}</Text>
        <Text style={styles.axisLabel}>Today</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  readout: { ...Type.subheadline, color: C.secondaryLabel, marginBottom: Space.m, minHeight: 20 },
  readoutStrong: { ...Type.headline, color: C.label, fontVariant: ['tabular-nums'] },
  plot: { height: HEIGHT, justifyContent: 'flex-end' },
  maxLabel: { ...Type.caption, color: C.tertiaryLabel, position: 'absolute', top: 0, right: 0, fontVariant: ['tabular-nums'] },
  maxLine: {
    position: 'absolute',
    top: 18,
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: C.separator,
  },
  bars: { flexDirection: 'row', alignItems: 'flex-end', height: HEIGHT, gap: 2 },
  column: { flex: 1, height: '100%', justifyContent: 'flex-end' },
  bar: { backgroundColor: C.tint, borderTopLeftRadius: 4, borderTopRightRadius: 4 },
  baseline: { height: StyleSheet.hairlineWidth, backgroundColor: C.separator },
  axis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  axisLabel: { ...Type.caption, color: C.tertiaryLabel },
});
