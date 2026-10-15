import * as Haptics from 'expo-haptics';
import { router, useFocusEffect } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Linking, RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { IconTile, Row, Section } from '@/components/ui';
import { C, Space, Type } from '@/constants/theme';
import { accountLabel } from '@/lib/account';
import { signOut, useSession } from '@/lib/auth';
import { hostState, timeAgo, type HostState } from '@/lib/format';
import { disablePush, enablePush, pushStatus, pushSupport, type PushStatus } from '@/lib/notifications';
import { fetchHosts, revokeHost, useLive, type Host } from '@/lib/relay';

const STATE: Record<HostState, { label: (h: Host) => string; color: typeof C.green }> = {
  online: { label: () => 'Online', color: C.green },
  offline: { label: (h) => `Offline · seen ${timeAgo(Date.parse(h.last_seen_at!))}`, color: C.gray },
  never: { label: () => 'Waiting for first sync', color: C.orange },
  revoked: { label: (h) => `Removed ${timeAgo(Date.parse(h.revoked_at!))}`, color: C.red },
};

function confirmRemove(h: Host, onDone: () => void) {
  Alert.alert(
    `Remove “${h.name}”?`,
    'It stops syncing immediately and can’t write to your account again. What it already synced stays here.',
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            await revokeHost(h.id);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          } catch {
            Alert.alert('Couldn’t remove it', 'Check your connection and try again.');
          }
          onDone();
        },
      },
    ],
  );
}

function confirmSignOut(onStart: () => void) {
  Alert.alert('Sign out?', 'Your computers keep running and syncing. Sign in again any time to see them.', [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Sign Out',
      style: 'destructive',
      onPress: () => {
        onStart();
        signOut();
      },
    },
  ]);
}

function NotificationsSection() {
  const support = pushSupport();
  const [status, setStatus] = useState<PushStatus | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    if (support === 'ok') pushStatus().then(setStatus);
  }, [support]);
  useFocusEffect(refresh);

  if (support !== 'ok') {
    return (
      <Section
        title="Notifications"
        footer={
          support === 'expo-go'
            ? 'Notifications need the Praktor app itself — Expo Go can’t receive them. They switch on once you install the development build.'
            : 'Notifications need a real iPhone.'
        }>
        <Row title="Notify me" subtitle="Not available here" leading={<IconTile symbol="bell.fill" color={C.gray} />} />
      </Section>
    );
  }

  async function toggle(next: boolean) {
    setBusy(true);
    if (next) {
      const result = await enablePush();
      if (!result.ok && result.reason === 'denied') {
        Alert.alert('Notifications are off', 'Turn on notifications for Praktor in iOS Settings to be told when it needs you.', [
          { text: 'Not Now', style: 'cancel' },
          { text: 'Open Settings', onPress: () => Linking.openSettings() },
        ]);
      } else if (!result.ok) {
        Alert.alert('Couldn’t turn on notifications', 'Check your connection and try again.');
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } else {
      await disablePush();
    }
    setBusy(false);
    refresh();
  }

  return (
    <Section
      title="Notifications"
      footer="Praktor tells you when a decision needs you, when work is ready to merge, and when something fails. Notifications show titles only — never code.">
      <Row
        title="Notify me"
        subtitle={status === 'denied' ? 'Off in iOS Settings — tap to open' : undefined}
        leading={<IconTile symbol="bell.fill" color={C.red} />}
        onPress={status === 'denied' ? () => Linking.openSettings() : undefined}
        trailing={
          status === 'denied' ? undefined : (
            <Switch
              value={status === 'on'}
              disabled={busy || status === undefined}
              onValueChange={toggle}
              accessibilityLabel="Notify me"
            />
          )
        }
      />
    </Section>
  );
}

export default function Computers() {
  const session = useSession();
  const hosts = useLive('hosts', ['hosts'], fetchHosts);
  const active = (hosts.data ?? []).filter((h) => !h.revoked_at);
  const removed = (hosts.data ?? []).filter((h) => h.revoked_at);
  const account = accountLabel(session?.user);
  const [signingOut, setSigningOut] = useState(false);

  return (
    <ScrollView
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={hosts.refreshing} onRefresh={hosts.refresh} />}>
      <Section
        title="Your computers"
        footer={
          active.length === 0
            ? 'Run “exec-agent cloud connect” on your computer, then tap Add a Computer and scan the code it shows.'
            : 'Tap a computer to remove it.'
        }>
        {active.map((h) => {
          const state = hostState(h);
          const look = STATE[state];
          return (
            <Row
              key={h.id}
              title={h.name}
              subtitle={look.label(h)}
              leading={<IconTile symbol="desktopcomputer" color={look.color} />}
              onPress={() => confirmRemove(h, hosts.refresh)}
              accessibilityHint="Offers to remove this computer"
            />
          );
        })}
        <Row
          title="Add a Computer"
          tinted
          leading={<SymbolView name="plus.circle.fill" size={28} tintColor={C.tint} />}
          onPress={() => router.push('/add-computer')}
        />
      </Section>

      {removed.length > 0 ? (
        <Section title="Removed" footer="These can no longer sync. Their history stays visible.">
          {removed.map((h) => (
            <Row
              key={h.id}
              title={h.name}
              subtitle={STATE.revoked.label(h)}
              leading={<IconTile symbol="desktopcomputer" color={C.gray} />}
            />
          ))}
        </Section>
      ) : null}

      <NotificationsSection />

      <Section title="Account">
        <Row title={account.title} subtitle={account.subtitle} leading={<IconTile symbol={account.symbol} color={C.gray} />} />
        <Row
          title={signingOut ? 'Signing Out…' : 'Sign Out'}
          destructive
          onPress={signingOut ? undefined : () => confirmSignOut(() => setSigningOut(true))}
          trailing={signingOut ? <ActivityIndicator /> : undefined}
        />
      </Section>

      <View style={styles.privacy}>
        <SymbolView name="lock.shield" size={16} tintColor={C.tertiaryLabel} />
        <Text style={styles.privacyText}>
          Your source code stays on your computer. Praktor syncs status, costs, decisions and file names only.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.background },
  privacy: {
    flexDirection: 'row',
    gap: Space.s,
    marginHorizontal: Space.xxl,
    marginTop: Space.xl,
    marginBottom: Space.xxl * 2,
    justifyContent: 'center',
  },
  privacyText: { ...Type.footnote, color: C.tertiaryLabel, flexShrink: 1, textAlign: 'center' },
});
