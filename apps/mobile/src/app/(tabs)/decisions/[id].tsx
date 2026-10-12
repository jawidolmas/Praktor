import * as Haptics from 'expo-haptics';
import { Stack, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ComputerNotice } from '@/components/computer-notice';
import { EmptyState, PrimaryButton } from '@/components/ui';
import { C, Radius, Space, Type } from '@/constants/theme';
import { answeredVia, timeAgo } from '@/lib/format';
import {
  fetchDecision,
  fetchHosts,
  sendDecisionAnswer,
  useLive,
  type Decision,
  type DecisionAnswer,
  type DecisionOption,
} from '@/lib/relay';

function OptionCard({
  option,
  recommended,
  selected,
  disabled,
  onSelect,
}: {
  option: DecisionOption;
  recommended: boolean;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <Pressable
      onPress={onSelect}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled }}
      accessibilityLabel={`${option.label}${recommended ? ', recommended' : ''}`}
      style={({ pressed }) => [
        styles.option,
        selected && styles.optionSelected,
        pressed && !disabled && { backgroundColor: C.cardPressed },
      ]}>
      <View style={styles.optionHead}>
        <SymbolView
          name={selected ? 'checkmark.circle.fill' : 'circle'}
          size={24}
          tintColor={selected ? C.tint : C.tertiaryLabel}
        />
        <Text style={styles.optionLabel}>{option.label}</Text>
      </View>
      {recommended ? (
        <View style={styles.recommended}>
          <SymbolView name="star.fill" size={10} tintColor={C.tint} />
          <Text style={styles.recommendedText}>Recommended</Text>
        </View>
      ) : null}
      {(option.pros ?? []).map((p, i) => (
        <View key={`p${i}`} style={styles.point}>
          <SymbolView name="plus.circle.fill" size={14} tintColor={C.green} />
          <Text style={styles.pointText}>{p}</Text>
        </View>
      ))}
      {(option.cons ?? []).map((c, i) => (
        <View key={`c${i}`} style={styles.point}>
          <SymbolView name="minus.circle.fill" size={14} tintColor={C.red} />
          <Text style={styles.pointText}>{c}</Text>
        </View>
      ))}
    </Pressable>
  );
}

/** What happened to an answer sent from this app, live. */
function AnswerStatus({ answer, label }: { answer: DecisionAnswer; label: string }) {
  const look =
    answer.status === 'applied'
      ? { symbol: 'checkmark.circle.fill' as const, color: C.green, title: `Answered “${label}”`, body: 'Applied on your computer. The agent is carrying on.' }
      : answer.status === 'rejected'
        ? { symbol: 'exclamationmark.triangle.fill' as const, color: C.orange, title: 'Not applied', body: answer.message ?? 'Your computer couldn’t apply this answer.' }
        : {
            symbol: undefined,
            color: C.secondaryLabel,
            title: `Sending “${label}”…`,
            body: 'Waiting for your computer to apply it.',
          };
  return (
    <View style={[styles.status, { borderColor: look.color }]} accessibilityLiveRegion="polite">
      {look.symbol ? <SymbolView name={look.symbol} size={26} tintColor={look.color} /> : <ActivityIndicator />}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.statusTitle}>{look.title}</Text>
        <Text style={styles.statusBody}>{look.body}</Text>
      </View>
    </View>
  );
}

export default function DecisionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const detail = useLive(
    `decision:${id}`,
    [
      { table: 'decisions', filter: `id=eq.${id}` },
      { table: 'decision_answers', filter: `decision_id=eq.${id}` },
    ],
    () => fetchDecision(id),
  );
  const hosts = useLive('hosts', ['hosts'], fetchHosts);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);

  const d: Decision | undefined = detail.data?.decision;
  const answer = detail.data?.answer ?? null;
  const host = hosts.data?.find((h) => h.id === d?.host_id);

  // Pre-select the agent's recommendation — the most likely answer is one
  // tap away, but nothing is sent without an explicit confirm.
  useEffect(() => {
    if (d && selected === undefined && d.options.some((o) => o.id === d.recommendation)) setSelected(d.recommendation);
  }, [d, selected]);

  // Celebrate the moment the computer confirms, once.
  const lastStatus = useRef(answer?.status);
  useEffect(() => {
    if (answer?.status === 'applied' && lastStatus.current === 'pending') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    lastStatus.current = answer?.status;
  }, [answer?.status]);

  function confirmAndSend(option: DecisionOption) {
    Alert.alert(
      `Answer “${option.label}”?`,
      'Your computer applies it right away. It can’t be changed afterwards.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send',
          onPress: async () => {
            setSending(true);
            try {
              await sendDecisionAnswer(id, option.id);
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              await detail.refresh();
            } catch (err) {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
              const msg = err instanceof Error ? err.message : '';
              Alert.alert(
                'Couldn’t send the answer',
                /already answered/i.test(msg)
                  ? 'This decision was already answered somewhere else.'
                  : /was removed/i.test(msg)
                    ? 'The computer that asked has been removed from your account.'
                    : 'Check your connection and try again.',
              );
              await detail.refresh();
            } finally {
              setSending(false);
            }
          },
        },
      ],
    );
  }

  let body: React.ReactNode;
  if (detail.error) {
    body = <EmptyState symbol="wifi.exclamationmark" title="Can’t reach Praktor" message="Check your connection. Pull down to try again." />;
  } else if (detail.data === undefined) {
    body = <ActivityIndicator style={{ marginTop: 80 }} />;
  } else if (!d) {
    body = <EmptyState symbol="questionmark.bubble" title="Decision not found" message="It may belong to a computer you removed." />;
  } else {
    const open = d.status === 'open' && !answer;
    const chosenLabel = (optId: string | null) => d.options.find((o) => o.id === optId)?.label ?? optId ?? '';
    const selectedOption = d.options.find((o) => o.id === selected);

    body = (
      <>
        <View style={styles.head}>
          <Text style={styles.kicker}>
            {d.key} · asked {timeAgo(d.created_at)}
            {host ? ` · ${host.name}` : ''}
          </Text>
          <Text style={styles.title} accessibilityRole="header">
            {d.title}
          </Text>
          {d.objective ? (
            <Text style={styles.objective} numberOfLines={2}>
              {d.objective.title}
            </Text>
          ) : null}
        </View>

        {d.context ? (
          <View style={styles.block}>
            <Text style={styles.blockLabel}>What happened</Text>
            <Text style={styles.blockText} selectable>
              {d.context}
            </Text>
          </View>
        ) : null}

        {d.risk ? (
          <View style={[styles.block, styles.riskBlock]}>
            <View style={styles.riskHead}>
              <SymbolView name="exclamationmark.triangle.fill" size={14} tintColor={C.orange} />
              <Text style={[styles.blockLabel, { color: C.orange, marginBottom: 0 }]}>Risk</Text>
            </View>
            <Text style={styles.blockText} selectable>
              {d.risk}
            </Text>
          </View>
        ) : null}

        {answer ? (
          <View style={styles.statusWrap}>
            <AnswerStatus answer={answer} label={chosenLabel(answer.answer)} />
            {answer.status === 'pending' ? (
              <View style={{ marginTop: Space.m }}>
                <ComputerNotice host={host} capability="answers" pendingSince={answer.created_at} />
              </View>
            ) : null}
          </View>
        ) : d.status !== 'open' ? (
          <View style={styles.statusWrap}>
            <View style={[styles.status, { borderColor: C.green }]}>
              <SymbolView name="checkmark.circle.fill" size={26} tintColor={C.green} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.statusTitle}>Answered “{chosenLabel(d.answer)}”</Text>
                <Text style={styles.statusBody}>
                  {[answeredVia(d.answered_by), d.answered_at ? timeAgo(d.answered_at) : ''].filter(Boolean).join(' · ')}
                </Text>
              </View>
            </View>
          </View>
        ) : null}

        <Text style={styles.optionsLabel}>{open ? 'Choose an answer' : 'Options'}</Text>
        <View style={styles.options}>
          {d.options.map((o) => (
            <OptionCard
              key={o.id}
              option={o}
              recommended={o.id === d.recommendation}
              selected={open ? selected === o.id : (answer?.answer ?? d.answer) === o.id}
              disabled={!open || sending}
              onSelect={() => {
                Haptics.selectionAsync();
                setSelected(o.id);
              }}
            />
          ))}
        </View>

        {open ? (
          <View style={styles.send}>
            {sending ? (
              <ActivityIndicator />
            ) : (
              <PrimaryButton
                title={selectedOption ? `Send “${selectedOption.label}”` : 'Choose an answer'}
                symbol="paperplane.fill"
                onPress={() => selectedOption && confirmAndSend(selectedOption)}
              />
            )}
            <ComputerNotice host={host} capability="answers" />
          </View>
        ) : null}
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: d?.key ?? '' }} />
      <ScrollView
        style={styles.screen}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={detail.refreshing} onRefresh={detail.refresh} />}>
        {body}
        <View style={{ height: Space.xxl * 3 }} />
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.background },
  head: { marginHorizontal: Space.xl, marginTop: Space.m, gap: 6 },
  kicker: { ...Type.footnote, color: C.secondaryLabel },
  title: { ...Type.title2, color: C.label },
  objective: { ...Type.subheadline, color: C.secondaryLabel },

  block: {
    marginHorizontal: Space.l,
    marginTop: Space.l,
    padding: Space.l,
    backgroundColor: C.card,
    borderRadius: Radius.card,
    borderCurve: 'continuous',
  },
  blockLabel: { ...Type.footnote, fontWeight: '600', color: C.secondaryLabel, textTransform: 'uppercase', marginBottom: 6 },
  blockText: { ...Type.body, color: C.label, lineHeight: 23 },
  riskBlock: { borderLeftWidth: 3, borderLeftColor: C.orange },
  riskHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },

  statusWrap: { marginHorizontal: Space.l, marginTop: Space.l },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.m,
    padding: Space.l,
    backgroundColor: C.card,
    borderRadius: Radius.card,
    borderCurve: 'continuous',
    borderWidth: 1.5,
  },
  statusTitle: { ...Type.headline, color: C.label },
  statusBody: { ...Type.subheadline, color: C.secondaryLabel },

  optionsLabel: { ...Type.footnote, color: C.secondaryLabel, textTransform: 'uppercase', marginLeft: Space.l + Space.l, marginTop: Space.xl, marginBottom: Space.s - 2 },
  options: { marginHorizontal: Space.l, gap: Space.m },
  option: {
    padding: Space.l,
    gap: Space.s,
    backgroundColor: C.card,
    borderRadius: Radius.card,
    borderCurve: 'continuous',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  optionSelected: { borderColor: C.tint },
  optionHead: { flexDirection: 'row', alignItems: 'center', gap: Space.m },
  optionLabel: { ...Type.headline, color: C.label, flex: 1 },
  recommended: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 36 },
  recommendedText: { ...Type.caption, fontWeight: '600', color: C.tint },
  point: { flexDirection: 'row', gap: Space.s, alignItems: 'flex-start', marginLeft: 36 },
  pointText: { ...Type.subheadline, color: C.secondaryLabel, flex: 1 },

  send: { marginHorizontal: Space.l, marginTop: Space.xl, gap: Space.s, alignItems: 'stretch' },
});
