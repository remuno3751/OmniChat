import type { MotionAmount, StreamAnim } from '../deviceSettings';

/** Factors derived from Settings > Appearance > Animation amount (pure; see __tests__/motion.test.ts). */
export interface MotionFactors {
  amount: MotionAmount;
  /** false = no animation at all (amount Off or OS prefers-reduced-motion) */
  on: boolean;
  /** multiplies the theme's fast/base/slow durations */
  durK: number;
  /** multiplies slide/scale distances */
  distK: number;
  /** ms between list items entering (0 = none) */
  stagger: number;
}

export function motionFactors(amount: MotionAmount, osReduce: boolean): MotionFactors {
  if (osReduce || amount === 'off') return { amount, on: false, durK: 0, distK: 0, stagger: 0 };
  switch (amount) {
    // reduced still animates (lighter than standard): visible on Android, but shorter and shorter travel, no stagger
    case 'reduced': return { amount, on: true, durK: 0.75, distK: 0.7, stagger: 0 };
    case 'rich': return { amount, on: true, durK: 1.25, distK: 1.4, stagger: 28 };
    default: return { amount: 'standard', on: true, durK: 1, distK: 1, stagger: 0 };
  }
}

/** The streaming animation actually used: OS reduce-motion / amount Off → off; particles need web (native falls back to smooth). */
export function resolveStreamAnim(mode: StreamAnim, mo: MotionFactors, web: boolean): StreamAnim {
  if (mode === 'off' || mo.amount === 'off') return 'off';
  // OS "reduce motion" (e.g. Windows animation effects off) only removes the flashy particle effect: revealing the
  // text steadily is reading pace, not decoration, so Smooth stays on. Particles falls back to Smooth.
  if (!mo.on) return 'smooth';
  if (mode === 'particles' && !web) return 'smooth';
  return mode;
}
