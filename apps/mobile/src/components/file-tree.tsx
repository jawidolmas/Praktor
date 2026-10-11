import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import { LayoutAnimation, Pressable, StyleSheet, Text, View } from 'react-native';

import { C, Radius, Space, Type } from '@/constants/theme';
import { changeLook } from '@/lib/format';
import type { FolderNode, TreeNode } from '@/lib/tree';

/** Trees up to this many files open fully expanded; bigger ones open one
 *  level deep so a large change set doesn't bury the screen. */
const EXPAND_ALL_UP_TO = 40;

interface Row {
  node: TreeNode;
  depth: number;
}

function allFolderPaths(nodes: TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === 'folder') {
      out.push(n.path);
      allFolderPaths(n.children, out);
    }
  }
  return out;
}

function visibleRows(nodes: TreeNode[], open: Set<string>, depth = 0, out: Row[] = []): Row[] {
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.kind === 'folder' && open.has(node.path)) visibleRows(node.children, open, depth + 1, out);
  }
  return out;
}

export function FileTree({ tree, total }: { tree: TreeNode[]; total: number }) {
  const [open, setOpen] = useState<Set<string>>(
    () =>
      new Set(
        total <= EXPAND_ALL_UP_TO
          ? allFolderPaths(tree)
          : tree.filter((n): n is FolderNode => n.kind === 'folder').map((n) => n.path),
      ),
  );
  const rows = useMemo(() => visibleRows(tree, open), [tree, open]);

  function toggle(path: string) {
    Haptics.selectionAsync();
    LayoutAnimation.configureNext(LayoutAnimation.create(220, 'easeInEaseOut', 'opacity'));
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <View style={styles.card}>
      {rows.map(({ node, depth }, i) => (
        <View key={node.path}>
          {i > 0 ? <View style={[styles.separator, { marginLeft: Space.l + depth * 18 + 30 }]} /> : null}
          {node.kind === 'folder' ? (
            <Pressable
              onPress={() => toggle(node.path)}
              accessibilityRole="button"
              accessibilityLabel={`${node.name} folder, ${node.count} changed ${node.count === 1 ? 'file' : 'files'}`}
              accessibilityState={{ expanded: open.has(node.path) }}
              style={({ pressed }) => [styles.row, { paddingLeft: Space.l + depth * 18 }, pressed && styles.pressed]}>
              <View style={[styles.chevron, open.has(node.path) && styles.chevronOpen]}>
                <SymbolView name="chevron.right" size={11} tintColor={C.tertiaryLabel} weight="bold" />
              </View>
              <SymbolView name="folder.fill" size={18} tintColor={C.tint} />
              <Text style={styles.folderName} numberOfLines={1} ellipsizeMode="middle">
                {node.name}
              </Text>
              <Text style={styles.count}>{node.count}</Text>
            </Pressable>
          ) : (
            <FileRow node={node} depth={depth} />
          )}
        </View>
      ))}
    </View>
  );
}

function FileRow({ node, depth }: { node: Extract<TreeNode, { kind: 'file' }>; depth: number }) {
  const look = changeLook(node.change);
  const deleted = node.change === 'D';
  return (
    <View
      style={[styles.row, { paddingLeft: Space.l + depth * 18 + 17 }]}
      accessible
      accessibilityLabel={`${node.name}, ${look.label}${node.oldPath ? `, from ${node.oldPath}` : ''}`}>
      <SymbolView name={deleted ? 'doc' : 'doc.text'} size={16} tintColor={C.secondaryLabel} />
      <View style={styles.fileText}>
        <Text
          style={[styles.fileName, deleted && styles.deleted]}
          numberOfLines={1}
          ellipsizeMode="middle">
          {node.name}
        </Text>
        {node.oldPath ? (
          <Text style={styles.renamed} numberOfLines={1} ellipsizeMode="middle">
            from {node.oldPath}
          </Text>
        ) : null}
      </View>
      <View style={[styles.badge, { borderColor: look.color }]}>
        <Text style={[styles.badgeText, { color: look.color }]}>{look.short}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: C.card, borderRadius: Radius.card, borderCurve: 'continuous', overflow: 'hidden' },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: C.separator },
  row: { flexDirection: 'row', alignItems: 'center', gap: Space.s, minHeight: 44, paddingRight: Space.l },
  pressed: { backgroundColor: C.cardPressed },
  chevron: { width: 12, alignItems: 'center' },
  chevronOpen: { transform: [{ rotate: '90deg' }] },
  folderName: { ...Type.body, fontWeight: '500', color: C.label, flex: 1 },
  count: { ...Type.footnote, color: C.tertiaryLabel, fontVariant: ['tabular-nums'] },
  fileText: { flex: 1, paddingVertical: 6 },
  fileName: { ...Type.callout, fontFamily: 'Menlo', fontSize: 14, color: C.label },
  deleted: { textDecorationLine: 'line-through', color: C.secondaryLabel },
  renamed: { ...Type.caption, color: C.tertiaryLabel },
  badge: {
    width: 22,
    height: 20,
    borderRadius: 6,
    borderCurve: 'continuous',
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 11, fontWeight: '700' },
});
