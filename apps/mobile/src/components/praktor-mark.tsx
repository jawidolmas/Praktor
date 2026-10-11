import Svg, { Path, Rect } from 'react-native-svg';

export const BRAND_BLUE = '#066ce7';
export const BRAND_INK = '#0a0b0d';

/** The Praktor mark — the terminal prompt in a framed tile — drawn from the
 *  same 32×32 geometry as the site's favicon, so it stays crisp at any size. */
export function PraktorMark({ size = 88 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" accessibilityLabel="Praktor">
      <Rect width={32} height={32} rx={7} fill={BRAND_INK} />
      <Rect x={1} y={1} width={30} height={30} rx={6} fill="none" stroke={BRAND_BLUE} strokeWidth={1.4} />
      <Path
        d="M9 11l6 5-6 5"
        fill="none"
        stroke={BRAND_BLUE}
        strokeWidth={2.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path d="M18 21h6" stroke={BRAND_BLUE} strokeWidth={2.6} strokeLinecap="round" />
    </Svg>
  );
}
