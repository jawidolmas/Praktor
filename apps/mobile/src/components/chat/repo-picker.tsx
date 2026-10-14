import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { C, Radius, Space, Type } from '@/constants/theme';
import { hostState } from '@/lib/format';
import type { Host, Repo } from '@/lib/relay';

export interface Target {
  hostId: string;
  repoKey: string;
  repoName: string;
}

/** Recently used first, then alphabetical — the repo you're most likely to
 *  want is at the top. */
export function sortRepos(repos: Repo[]): Repo[] {
  return [...repos].sort(
    (a, b) => (b.last_used_at ?? 0) - (a.last_used_at ?? 0) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
}

/** Where a new conversation goes by default: the most recently used repo on
 *  a computer that's online, else on any active computer. */
export function defaultTarget(hosts: Host[], repos: Repo[]): Target | undefined {
  const active = hosts.filter((h) => !h.revoked_at);
  const online = new Set(active.filter((h) => hostState(h) === 'online').map((h) => h.id));
  const usable = sortRepos(repos.filter((r) => active.some((h) => h.id === r.host_id)));
  const pick = usable.find((r) => online.has(r.host_id)) ?? usable[0];
  return pick ? { hostId: pick.host_id, repoKey: pick.key, repoName: pick.name } : undefined;
}

export function RepoPicker({
  visible,
  hosts,
  repos,
  selected,
  onPick,
  onClose,
}: {
  visible: boolean;
  hosts: Host[];
  repos: Repo[];
  selected: Target | undefined;
  onPick: (t: Target) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const sections = useMemo(
    () =>
      hosts
        .filter((h) => !h.revoked_at)
        .map((h) => ({
          host: h,
          repos: sortRepos(repos.filter((r) => r.host_id === h.id && (!q || r.name.toLowerCase().includes(q)))),
        }))
        .filter((s) => s.repos.length > 0),
    [hosts, repos, q],
  );

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.sheet, { paddingBottom: insets.bottom }]}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Choose a Repo</Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close" style={styles.close}>
            <SymbolView name="xmark" size={13} tintColor={C.secondaryLabel} weight="bold" />
          </Pressable>
        </View>
        <View style={styles.search}>
          <SymbolView name="magnifyingglass" size={15} tintColor={C.tertiaryLabel} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search repos"
            placeholderTextColor={C.tertiaryLabel}
            style={styles.searchInput}
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
          />
        </View>
        <ScrollView keyboardShouldPersistTaps="handled">
          {sections.length === 0 ? (
            <Text style={styles.empty}>
              {repos.length === 0
                ? 'No repos yet. Your computer lists the git repos on its Desktop (and anywhere in EXEC_REPO_SEARCH_PATHS) within a few minutes of connecting.'
                : 'No repo matches that search.'}
            </Text>
          ) : (
            sections.map(({ host, repos: list }) => {
              const online = hostState(host) === 'online';
              return (
                <View key={host.id} style={styles.section}>
                  <View style={styles.sectionHead}>
                    <View style={[styles.dot, { backgroundColor: online ? C.green : C.gray }]} />
                    <Text style={styles.sectionTitle}>
                      {host.name}
                      {online ? '' : ' · offline'}
                    </Text>
                  </View>
                  <View style={styles.card}>
                    {list.map((r, i) => {
                      const isSelected = selected?.hostId === r.host_id && selected.repoKey === r.key;
                      return (
                        <Pressable
                          key={r.key}
                          onPress={() => {
                            Haptics.selectionAsync();
                            onPick({ hostId: r.host_id, repoKey: r.key, repoName: r.name });
                          }}
                          accessibilityRole="button"
                          accessibilityState={{ selected: isSelected }}
                          style={({ pressed }) => [styles.row, pressed && { backgroundColor: C.cardPressed }]}>
                          {i > 0 ? <View style={styles.separator} /> : null}
                          <View style={styles.rowBody}>
                            <SymbolView name="folder.fill" size={18} tintColor={C.tint} />
                            <Text style={styles.repoName} numberOfLines={1}>
                              {r.name}
                            </Text>
                            {isSelected ? <SymbolView name="checkmark" size={15} tintColor={C.tint} weight="semibold" /> : null}
                          </View>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              );
            })
          )}
          <View style={{ height: Space.xxl }} />
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: C.background },
  header: { alignItems: 'center', justifyContent: 'center', paddingTop: Space.xl, paddingBottom: Space.m },
  headerTitle: { ...Type.headline, color: C.label },
  close: {
    position: 'absolute',
    right: Space.l,
    top: Space.l + 2,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: C.fill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.s,
    marginHorizontal: Space.l,
    paddingHorizontal: Space.m,
    height: 38,
    borderRadius: Radius.control - 4,
    backgroundColor: C.fill,
  },
  searchInput: { flex: 1, ...Type.body, color: C.label, paddingVertical: 0 },
  section: { marginTop: Space.xl, marginHorizontal: Space.l },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: Space.l, marginBottom: Space.s - 2 },
  sectionTitle: { ...Type.footnote, fontWeight: '600', color: C.secondaryLabel },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  card: { backgroundColor: C.card, borderRadius: Radius.card, borderCurve: 'continuous', overflow: 'hidden' },
  row: { paddingHorizontal: Space.l },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: C.separator, marginLeft: 30 },
  rowBody: { flexDirection: 'row', alignItems: 'center', gap: Space.m, minHeight: 48 },
  repoName: { ...Type.body, color: C.label, flex: 1 },
  empty: { ...Type.subheadline, color: C.secondaryLabel, textAlign: 'center', margin: Space.xxl, lineHeight: 21 },
});
