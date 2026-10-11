import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Children, Fragment, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type ColorValue } from 'react-native';

import { C, Radius, Space, Type } from '@/constants/theme';
import type { StatusLook } from '@/lib/format';

/** An inset-grouped section: optional header, rounded card, optional footer,
 *  with hairline separators between rows — the iOS Settings pattern. */
export function Section({ title, footer, children }: { title?: string; footer?: string; children: ReactNode }) {
  const rows = Children.toArray(children).filter(Boolean);
  return (
    <View style={styles.section}>
      {title ? <Text style={styles.sectionTitle}>{title}</Text> : null}
      <View style={styles.card}>
        {rows.map((row, i) => (
          <Fragment key={i}>
            {i > 0 ? <View style={styles.separator} /> : null}
            {row}
          </Fragment>
        ))}
      </View>
      {footer ? <Text style={styles.sectionFooter}>{footer}</Text> : null}
    </View>
  );
}

/** A colored rounded square holding an SF Symbol, like Settings rows. */
export function IconTile({ symbol, color, size = 30 }: { symbol: SFSymbol; color: ColorValue; size?: number }) {
  return (
    <View style={[styles.tile, { width: size, height: size, backgroundColor: color }]}>
      <SymbolView name={symbol} size={size * 0.58} tintColor="white" weight="semibold" />
    </View>
  );
}

export function Row({
  title,
  subtitle,
  leading,
  trailing,
  onPress,
  destructive,
  tinted,
  accessibilityHint,
}: {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  destructive?: boolean;
  tinted?: boolean;
  accessibilityHint?: string;
}) {
  const color = destructive ? C.red : tinted ? C.tint : C.label;
  const body = (
    <View style={styles.row}>
      {leading}
      <View style={styles.rowText}>
        <Text style={[Type.body, { color }]} numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[Type.subheadline, { color: C.secondaryLabel }]} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => (pressed ? { backgroundColor: C.cardPressed } : undefined)}>
      {body}
    </Pressable>
  );
}

export function StatusPill({ look }: { look: StatusLook }) {
  return (
    <View style={styles.pill} accessibilityLabel={`Status: ${look.label}`}>
      <SymbolView name={look.symbol} size={12} tintColor={look.color} weight="semibold" />
      <Text style={[styles.pillText, { color: look.color }]}>{look.label}</Text>
    </View>
  );
}

export function EmptyState({
  symbol,
  title,
  message,
  action,
}: {
  symbol: SFSymbol;
  title: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <View style={styles.empty}>
      <SymbolView name={symbol} size={44} tintColor={C.tertiaryLabel} weight="regular" />
      <Text style={[Type.title3, styles.emptyTitle]}>{title}</Text>
      <Text style={[Type.subheadline, styles.emptyMessage]}>{message}</Text>
      {action}
    </View>
  );
}

/** A filled, capsule-shaped primary button. */
export function PrimaryButton({ title, onPress, symbol }: { title: string; onPress: () => void; symbol?: SFSymbol }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.primary, pressed && { opacity: 0.75 }]}>
      {symbol ? <SymbolView name={symbol} size={17} tintColor="white" weight="semibold" /> : null}
      <Text style={[Type.headline, { color: 'white' }]}>{title}</Text>
    </Pressable>
  );
}

export const styles = StyleSheet.create({
  section: { marginTop: Space.xl, marginHorizontal: Space.l },
  sectionTitle: {
    ...Type.footnote,
    color: C.secondaryLabel,
    textTransform: 'uppercase',
    marginLeft: Space.l,
    marginBottom: Space.s - 2,
  },
  sectionFooter: { ...Type.footnote, color: C.secondaryLabel, marginHorizontal: Space.l, marginTop: Space.s - 2 },
  card: { backgroundColor: C.card, borderRadius: Radius.card, borderCurve: 'continuous', overflow: 'hidden' },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: C.separator, marginLeft: 58 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.m,
    minHeight: 52,
    paddingHorizontal: Space.l,
    paddingVertical: Space.m - 2,
  },
  rowText: { flex: 1, gap: 2 },
  tile: { borderRadius: 8, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pillText: { ...Type.footnote, fontWeight: '600' },
  empty: { alignItems: 'center', paddingHorizontal: Space.xxl, paddingVertical: 56, gap: Space.s },
  emptyTitle: { color: C.label, textAlign: 'center', marginTop: Space.s },
  emptyMessage: { color: C.secondaryLabel, textAlign: 'center', lineHeight: 21, marginBottom: Space.m },
  primary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.s,
    backgroundColor: C.tint,
    borderRadius: Radius.pill,
    paddingHorizontal: Space.xl + 4,
    paddingVertical: 14,
    minHeight: 50,
  },
});
