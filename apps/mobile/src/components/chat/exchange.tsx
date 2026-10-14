import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { ComputerNotice } from '@/components/computer-notice';
import { PraktorMark } from '@/components/praktor-mark';
import { C, Radius, Space, Type } from '@/constants/theme';
import { answeredVia, duration, money, taskLook } from '@/lib/format';
import {
  requestMerge,
  sendDecisionAnswer,
  type Decision,
  type DecisionOption,
  type Host,
  type ThreadItem,
} from '@/lib/relay';

/**
 * One exchange in a conversation: what you asked, then Praktor's replies as
 * the work unfolds — starting, the plan, questions it needs you to answer,
 * and the result, with merging one tap away. Everything here is live: the
 * thread re-renders as the computer reports progress.
 */

function UserBubble({ text }: { text: string }) {
  return (
    <View style={styles.userRow}>
      <View style={styles.userBubble}>
        <Text style={styles.userText} selectable>
          {text}
        </Text>
      </View>
    </View>
  );
}

/** Praktor's side: its mark beside plain text, like an assistant reply. */
function Reply({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.reply}>
      <View style={styles.avatar}>
        <PraktorMark size={22} />
      </View>
      <View style={styles.replyBody}>{children}</View>
    </View>
  );
}

function Line({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return <Text style={[styles.line, muted && { color: C.secondaryLabel }]}>{children}</Text>;
}

function Working({ text }: { text: string }) {
  return (
    <View style={styles.working}>
      <ActivityIndicator size="small" />
      <Text style={[styles.line, { color: C.secondaryLabel }]}>{text}</Text>
    </View>
  );
}

function DecisionInline({ d }: { d: Decision }) {
  const [sending, setSending] = useState(false);
  const open = d.status === 'open';

  function choose(o: DecisionOption) {
    Haptics.selectionAsync();
    Alert.alert(`Answer “${o.label}”?`, 'Your computer applies it right away.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Send',
        onPress: async () => {
          setSending(true);
          try {
            await sendDecisionAnswer(d.id, o.id);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          } catch (err) {
            const msg = err instanceof Error ? err.message : '';
            Alert.alert(
              'Couldn’t send the answer',
              /already answered/i.test(msg) ? 'It was already answered somewhere else.' : 'Check your connection and try again.',
            );
          } finally {
            setSending(false);
          }
        },
      },
    ]);
  }

  if (!open) {
    const chosen = d.options.find((o) => o.id === d.answer)?.label ?? d.answer;
    return (
      <Line muted>
        You answered “{chosen}” {answeredVia(d.answered_by)}.
      </Line>
    );
  }

  return (
    <View style={styles.question}>
      <Text style={styles.questionTitle}>{d.title}</Text>
      {d.risk ? <Text style={styles.questionRisk}>Risk: {d.risk}</Text> : null}
      {sending ? (
        <ActivityIndicator style={{ alignSelf: 'flex-start' }} />
      ) : (
        <View style={styles.choices}>
          {d.options.map((o) => {
            const recommended = o.id === d.recommendation;
            return (
              <Pressable
                key={o.id}
                onPress={() => choose(o)}
                accessibilityRole="button"
                accessibilityLabel={`${o.label}${recommended ? ', recommended' : ''}`}
                style={({ pressed }) => [styles.choice, recommended && styles.choiceRecommended, pressed && { opacity: 0.6 }]}>
                <Text style={[styles.choiceText, recommended && { color: C.tint }]}>{o.label}</Text>
                {recommended ? <SymbolView name="star.fill" size={10} tintColor={C.tint} /> : null}
              </Pressable>
            );
          })}
        </View>
      )}
      <Pressable onPress={() => router.push({ pathname: '/decisions/[id]', params: { id: d.id } })} hitSlop={8}>
        <Text style={styles.link}>See pros, cons and context</Text>
      </Pressable>
    </View>
  );
}

function MergeInline({ item }: { item: ThreadItem }) {
  const [busy, setBusy] = useState(false);
  const o = item.objective!;
  const merge = item.merge;

  function confirm() {
    Alert.alert(`Merge into ${o.repo_name} and push?`, 'It stops safely if the repo has uncommitted changes.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Merge & Push',
        onPress: async () => {
          setBusy(true);
          try {
            await requestMerge(o.id);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          } catch {
            Alert.alert('Couldn’t start the merge', 'Check your connection and try again.');
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  }

  if (o.merged_at) return <Line>Merged and pushed. ✓</Line>;
  if (merge?.status === 'pending' || busy) return <Working text="Merging on your computer…" />;
  return (
    <View style={styles.actions}>
      {merge?.status === 'failed' ? <Line muted>Couldn’t merge: {merge.message}</Line> : null}
      <View style={styles.actionRow}>
        <Pressable onPress={confirm} accessibilityRole="button" style={({ pressed }) => [styles.actionPrimary, pressed && { opacity: 0.8 }]}>
          <SymbolView name="arrow.triangle.merge" size={14} tintColor="white" weight="semibold" />
          <Text style={styles.actionPrimaryText}>{merge?.status === 'failed' ? 'Try Again' : 'Merge & Push'}</Text>
        </Pressable>
        <Pressable
          onPress={() => router.push({ pathname: '/objectives/[id]', params: { id: o.id } })}
          accessibilityRole="button"
          style={({ pressed }) => [styles.actionSecondary, pressed && { opacity: 0.6 }]}>
          <Text style={styles.actionSecondaryText}>Review</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function Exchange({ item, host }: { item: ThreadItem; host: Host | undefined }) {
  const { request, objective, tasks, decisions } = item;
  const computer = host?.name ?? 'your computer';

  let reply: React.ReactNode;
  if (request.status === 'pending') {
    reply = (
      <>
        <Working text={`Sending to ${computer}…`} />
        <ComputerNotice host={host} capability="requests" pendingSince={request.created_at} />
      </>
    );
  } else if (request.status === 'rejected') {
    reply = <Line>I couldn’t start this. {request.reason ?? ''}</Line>;
  } else if (!objective) {
    reply = <Working text={`On it — starting in ${request.repo_name}…`} />;
  } else {
    const openDecisions = decisions.filter((d) => d.status === 'open');
    const answered = decisions.filter((d) => d.status !== 'open');
    const finished = objective.status === 'done' || objective.status === 'failed' || objective.status === 'cancelled';
    reply = (
      <>
        <Line>
          On it — working in <Text style={styles.strong}>{objective.repo_name}</Text> on {computer}.
        </Line>
        {objective.status === 'draft' ? <Working text="Planning how to do this…" /> : null}
        {tasks.length > 0 ? (
          <View style={styles.plan}>
            {tasks.length > 1 ? <Line muted>The plan:</Line> : null}
            {tasks.map((t) => {
              const look = taskLook(t.status);
              return (
                <View key={t.id} style={styles.step} accessible accessibilityLabel={`${t.title}: ${look.label}`}>
                  <SymbolView name={look.symbol} size={16} tintColor={look.color} />
                  <Text style={styles.stepText}>{t.title}</Text>
                </View>
              );
            })}
          </View>
        ) : null}
        {answered.map((d) => (
          <DecisionInline key={d.id} d={d} />
        ))}
        {openDecisions.map((d) => (
          <DecisionInline key={d.id} d={d} />
        ))}
        {objective.status === 'done' ? (
          <>
            <Line>{objective.merged_at ? 'Done.' : `Done — ready to merge into ${objective.repo_name}.`}</Line>
            <MergeInline item={item} />
          </>
        ) : objective.status === 'failed' ? (
          <>
            <Line>This one didn’t work out.{item.problem ? ` ${item.problem}` : ''}</Line>
            <Pressable onPress={() => router.push({ pathname: '/objectives/[id]', params: { id: objective.id } })} hitSlop={8}>
              <Text style={styles.link}>See what happened</Text>
            </Pressable>
          </>
        ) : objective.status === 'cancelled' ? (
          <Line muted>Cancelled.</Line>
        ) : objective.status === 'parked' ? (
          <Line muted>Paused for a rate limit — it carries on by itself.</Line>
        ) : null}
        {finished || objective.cost_usd > 0 ? (
          <Text style={styles.footnote}>
            {money(objective.cost_usd)}
            {finished ? ` · ${duration(objective.updated_at - objective.created_at)}` : ''}
          </Text>
        ) : null}
      </>
    );
  }

  return (
    <View style={styles.exchange}>
      <UserBubble text={request.message} />
      <Reply>{reply}</Reply>
    </View>
  );
}

const styles = StyleSheet.create({
  exchange: { gap: Space.l, marginBottom: Space.xl },
  userRow: { flexDirection: 'row', justifyContent: 'flex-end', paddingLeft: 48 },
  userBubble: {
    backgroundColor: C.fill,
    borderRadius: 20,
    borderCurve: 'continuous',
    paddingHorizontal: Space.l,
    paddingVertical: Space.m - 2,
  },
  userText: { ...Type.body, color: C.label },
  reply: { flexDirection: 'row', gap: Space.m, paddingRight: Space.s },
  avatar: { paddingTop: 1 },
  replyBody: { flex: 1, gap: Space.s + 2 },
  line: { ...Type.body, color: C.label, lineHeight: 24 },
  strong: { fontWeight: '600' },
  working: { flexDirection: 'row', alignItems: 'center', gap: Space.s },
  plan: { gap: 6 },
  step: { flexDirection: 'row', gap: Space.s, alignItems: 'flex-start' },
  stepText: { ...Type.callout, color: C.label, flex: 1 },
  question: {
    gap: Space.s,
    padding: Space.l,
    borderRadius: Radius.control + 4,
    borderCurve: 'continuous',
    backgroundColor: C.card,
    borderWidth: 1.5,
    borderColor: C.orange,
  },
  questionTitle: { ...Type.headline, color: C.label },
  questionRisk: { ...Type.footnote, color: C.secondaryLabel },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.s, marginTop: 2 },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Space.m + 2,
    paddingVertical: Space.s,
    borderRadius: Radius.pill,
    backgroundColor: C.fill,
  },
  choiceRecommended: { borderWidth: 1.5, borderColor: C.tint },
  choiceText: { ...Type.subheadline, fontWeight: '600', color: C.label },
  link: { ...Type.subheadline, color: C.tint },
  actions: { gap: Space.s },
  actionRow: { flexDirection: 'row', gap: Space.s },
  actionPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: C.tint,
    borderRadius: Radius.pill,
    paddingHorizontal: Space.l,
    paddingVertical: Space.s + 1,
  },
  actionPrimaryText: { ...Type.subheadline, fontWeight: '600', color: 'white' },
  actionSecondary: { borderRadius: Radius.pill, paddingHorizontal: Space.l, paddingVertical: Space.s + 1, backgroundColor: C.fill },
  actionSecondaryText: { ...Type.subheadline, fontWeight: '600', color: C.label },
  footnote: { ...Type.caption, color: C.tertiaryLabel },
});
