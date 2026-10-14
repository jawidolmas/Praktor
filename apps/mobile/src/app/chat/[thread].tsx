import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Exchange } from '@/components/chat/exchange';
import { defaultTarget, RepoPicker, type Target } from '@/components/chat/repo-picker';
import { ComputerNotice } from '@/components/computer-notice';
import { PraktorMark } from '@/components/praktor-mark';
import { C, Radius, Space, Type } from '@/constants/theme';
import { MAX_MESSAGE } from '@/lib/chat';
import { fetchHosts, fetchRepos, fetchThread, sendRequest, useLive, type ThreadItem } from '@/lib/relay';

const SUGGESTIONS = ['Add a README that explains this project', 'Fix the failing tests', 'Clean up unused code'];

/** Plain words for why sending failed; the server's own messages are terse. */
function sendErrorMessage(message: string): string {
  if (/too many requests/i.test(message)) return 'You’ve sent a lot of requests this hour. Try again a little later.';
  if (/not on that computer/i.test(message)) return 'That repo isn’t available on that computer anymore. Choose another.';
  if (/not connected/i.test(message)) return 'That computer isn’t connected to your account anymore.';
  if (/1-4000/i.test(message)) return 'Requests can be up to 4,000 characters.';
  return 'Check your connection and try again.';
}

export default function ChatScreen() {
  const params = useLocalSearchParams<{ thread: string }>();
  const insets = useSafeAreaInsets();
  // A new chat gets its id now, so the first message and every follow-up
  // share it — and a retry of the same send can't open a second thread.
  const threadId = useRef(params.thread === 'new' ? Crypto.randomUUID() : params.thread).current;

  const thread = useLive(
    `thread:${threadId}`,
    [{ table: 'requests', filter: `thread_id=eq.${threadId}` }, 'objectives', 'tasks', 'decisions', 'merge_requests'],
    () => fetchThread(threadId),
  );
  const hosts = useLive('hosts', ['hosts'], fetchHosts);
  const repos = useLive('repos', ['repos'], fetchRepos);

  const items: ThreadItem[] = thread.data ?? [];
  const last = items[items.length - 1]?.request;

  const [picked, setPicked] = useState<Target | undefined>(undefined);
  const target: Target | undefined = useMemo(() => {
    if (picked) return picked;
    if (last) return { hostId: last.host_id, repoKey: last.repo_key, repoName: last.repo_name };
    return defaultTarget(hosts.data ?? [], repos.data ?? []);
  }, [picked, last, hosts.data, repos.data]);
  const host = hosts.data?.find((h) => h.id === target?.hostId);

  const [text, setText] = useState('');
  const [sending, setSending] = useState<string | undefined>(undefined);
  const [pickerOpen, setPickerOpen] = useState(false);
  const scroll = useRef<ScrollView>(null);

  const trimmed = text.trim();
  const canSend = !!target && trimmed.length > 0 && trimmed.length <= MAX_MESSAGE && sending === undefined;

  async function send() {
    if (!canSend || !target) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const message = trimmed;
    setSending(message);
    setText('');
    try {
      await sendRequest({ id: Crypto.randomUUID(), threadId, hostId: target.hostId, repoKey: target.repoKey, message });
      if (params.thread === 'new') router.setParams({ thread: threadId });
      await thread.refresh();
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      // Give the words back: nothing typed is ever lost to a failed send.
      setText(message);
      Alert.alert('Couldn’t send', sendErrorMessage(err instanceof Error ? err.message : ''));
    } finally {
      setSending(undefined);
    }
  }

  const title = items[0]?.request.message.split(/\r?\n/)[0]?.slice(0, 40) ?? 'New Chat';
  const empty = items.length === 0 && sending === undefined;

  return (
    <>
      <Stack.Screen options={{ title }} />
      <KeyboardAvoidingView style={styles.screen} behavior="padding" keyboardVerticalOffset={insets.top + 44}>
        <ScrollView
          ref={scroll}
          style={styles.messages}
          contentContainerStyle={[styles.messagesContent, empty && { flexGrow: 1 }]}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}>
          {empty ? (
            <View style={styles.welcome}>
              <PraktorMark size={56} />
              <Text style={styles.welcomeTitle}>What should Praktor do?</Text>
              <Text style={styles.welcomeBody}>
                Say it in your own words. Your computer does the work, and you’ll hear back here.
              </Text>
              <View style={styles.suggestions}>
                {SUGGESTIONS.map((s) => (
                  <Pressable
                    key={s}
                    onPress={() => {
                      Haptics.selectionAsync();
                      setText(s);
                    }}
                    style={({ pressed }) => [styles.suggestion, pressed && { opacity: 0.6 }]}>
                    <Text style={styles.suggestionText}>{s}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : (
            <>
              {items.map((item) => (
                <Exchange key={item.request.id} item={item} host={hosts.data?.find((h) => h.id === item.request.host_id)} />
              ))}
              {sending !== undefined ? (
                <View style={styles.optimistic}>
                  <View style={styles.optimisticBubble}>
                    <Text style={styles.optimisticText}>{sending}</Text>
                  </View>
                </View>
              ) : null}
            </>
          )}
        </ScrollView>

        <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, Space.m) }]}>
          {host ? (
            <View style={styles.notice}>
              <ComputerNotice host={host} capability="requests" />
            </View>
          ) : null}
          <Pressable
            onPress={() => setPickerOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={target ? `Working in ${target.repoName} on ${host?.name ?? 'your computer'}. Change` : 'Choose a repo'}
            style={({ pressed }) => [styles.targetChip, pressed && { opacity: 0.6 }]}>
            <SymbolView name="desktopcomputer" size={13} tintColor={C.secondaryLabel} />
            <Text style={styles.targetText} numberOfLines={1}>
              {target ? `${host?.name ?? 'Computer'} · ${target.repoName}` : 'Choose a repo'}
            </Text>
            <SymbolView name="chevron.down" size={10} tintColor={C.secondaryLabel} weight="semibold" />
          </Pressable>

          <View style={styles.inputRow}>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder={items.length ? 'Reply to Praktor…' : 'Tell Praktor what you want…'}
              placeholderTextColor={C.tertiaryLabel}
              multiline
              maxLength={MAX_MESSAGE}
              autoFocus={params.thread === 'new'}
              style={styles.input}
              accessibilityLabel="Message"
            />
            <Pressable
              onPress={send}
              disabled={!canSend}
              accessibilityRole="button"
              accessibilityLabel="Send"
              style={[styles.send, { backgroundColor: canSend ? C.tint : C.fill }]}>
              <SymbolView name="arrow.up" size={16} tintColor={canSend ? 'white' : C.tertiaryLabel} weight="bold" />
            </Pressable>
          </View>
          {trimmed.length > MAX_MESSAGE - 500 ? (
            <Text style={styles.counter}>{MAX_MESSAGE - trimmed.length} characters left</Text>
          ) : null}
        </View>
      </KeyboardAvoidingView>

      <RepoPicker
        visible={pickerOpen}
        hosts={hosts.data ?? []}
        repos={repos.data ?? []}
        selected={target}
        onPick={(t) => {
          setPicked(t);
          setPickerOpen(false);
        }}
        onClose={() => setPickerOpen(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.background },
  messages: { flex: 1 },
  messagesContent: { paddingHorizontal: Space.l, paddingTop: Space.l, paddingBottom: Space.m },

  welcome: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Space.m, paddingHorizontal: Space.xl },
  welcomeTitle: { ...Type.title2, color: C.label, textAlign: 'center', marginTop: Space.s },
  welcomeBody: { ...Type.body, color: C.secondaryLabel, textAlign: 'center', lineHeight: 23 },
  suggestions: { gap: Space.s, alignSelf: 'stretch', marginTop: Space.l },
  suggestion: {
    paddingHorizontal: Space.l,
    paddingVertical: Space.m,
    borderRadius: Radius.control + 2,
    borderCurve: 'continuous',
    backgroundColor: C.card,
  },
  suggestionText: { ...Type.subheadline, color: C.label },

  optimistic: { flexDirection: 'row', justifyContent: 'flex-end', paddingLeft: 48, marginBottom: Space.xl },
  optimisticBubble: { backgroundColor: C.fill, borderRadius: 20, paddingHorizontal: Space.l, paddingVertical: Space.m - 2, opacity: 0.7 },
  optimisticText: { ...Type.body, color: C.label },

  composer: {
    paddingHorizontal: Space.m,
    paddingTop: Space.s,
    gap: Space.s,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.separator,
    backgroundColor: C.background,
  },
  notice: { marginHorizontal: Space.xs },
  targetChip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingHorizontal: Space.m,
    paddingVertical: 6,
    borderRadius: Radius.pill,
    backgroundColor: C.fill,
    maxWidth: '100%',
  },
  targetText: { ...Type.footnote, fontWeight: '600', color: C.secondaryLabel, flexShrink: 1 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Space.s,
    backgroundColor: C.card,
    borderRadius: 22,
    borderCurve: 'continuous',
    paddingLeft: Space.l,
    paddingRight: 6,
    paddingVertical: 6,
  },
  input: { flex: 1, ...Type.body, color: C.label, maxHeight: 140, paddingTop: 7, paddingBottom: 7 },
  send: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  counter: { ...Type.caption, color: C.orange, textAlign: 'right', marginRight: Space.s },
});
