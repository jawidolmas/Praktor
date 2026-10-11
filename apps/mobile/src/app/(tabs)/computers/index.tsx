import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { IconTile, Row, Section } from '@/components/ui';
import { C, Space, Type } from '@/constants/theme';
import { signOut, useSession } from '@/lib/auth';
import { hostState, timeAgo, type HostState } from '@/lib/format';
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

function confirmSignOut() {
  Alert.alert('Sign out?', 'Your computers keep running and syncing. Sign in again any time to see them.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Sign Out', style: 'destructive', onPress: () => signOut() },
  ]);
}

export default function Computers() {
  const session = useSession();
  const hosts = useLive('hosts', ['hosts'], fetchHosts);
  const active = (hosts.data ?? []).filter((h) => !h.revoked_at);
  const removed = (hosts.data ?? []).filter((h) => h.revoked_at);
  const name = (session?.user.user_metadata?.given_name as string | undefined) ?? 'Signed in with Apple';

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

      <Section title="Account">
        <Row title={name} leading={<IconTile symbol="person.fill" color={C.gray} />} />
        <Row title="Sign Out" destructive onPress={confirmSignOut} />
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
