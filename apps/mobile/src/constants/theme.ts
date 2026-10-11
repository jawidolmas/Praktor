import { PlatformColor, type ColorValue } from 'react-native';

/**
 * iOS semantic system colors. They adapt on their own to light / dark mode,
 * Increase Contrast, and whatever appearance future iOS releases ship — the
 * same colors Apple's own apps use, so the app reads as native rather than
 * as a themed imitation of it.
 */
export const C = {
  background: PlatformColor('systemGroupedBackground'),
  card: PlatformColor('secondarySystemGroupedBackground'),
  cardPressed: PlatformColor('tertiarySystemGroupedBackground'),
  label: PlatformColor('label'),
  secondaryLabel: PlatformColor('secondaryLabel'),
  tertiaryLabel: PlatformColor('tertiaryLabel'),
  separator: PlatformColor('separator'),
  fill: PlatformColor('tertiarySystemFill'),
  tint: PlatformColor('systemIndigo'),
  blue: PlatformColor('systemBlue'),
  green: PlatformColor('systemGreen'),
  orange: PlatformColor('systemOrange'),
  red: PlatformColor('systemRed'),
  gray: PlatformColor('systemGray'),
  purple: PlatformColor('systemPurple'),
} satisfies Record<string, ColorValue>;

export const Space = { xs: 4, s: 8, m: 12, l: 16, xl: 20, xxl: 32 } as const;

/** iOS 26 inset-grouped lists use large, continuous-curve corners. */
export const Radius = { card: 22, control: 14, pill: 999 } as const;

/** Apple's text styles (SF Pro, sizes and weights from the HIG). Dynamic
 *  Type scaling comes from React Native's default allowFontScaling. */
export const Type = {
  largeTitle: { fontSize: 34, fontWeight: '700', letterSpacing: 0.4 },
  title2: { fontSize: 22, fontWeight: '700', letterSpacing: 0.35 },
  title3: { fontSize: 20, fontWeight: '600', letterSpacing: 0.38 },
  headline: { fontSize: 17, fontWeight: '600', letterSpacing: -0.43 },
  body: { fontSize: 17, fontWeight: '400', letterSpacing: -0.43 },
  callout: { fontSize: 16, fontWeight: '400', letterSpacing: -0.31 },
  subheadline: { fontSize: 15, fontWeight: '400', letterSpacing: -0.23 },
  footnote: { fontSize: 13, fontWeight: '400', letterSpacing: -0.08 },
  caption: { fontSize: 12, fontWeight: '400', letterSpacing: 0 },
  mono: { fontFamily: 'Menlo', fontSize: 13 },
} as const;
