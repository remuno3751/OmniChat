import type { ContextOverflow } from './protocol';

/** Slider steps, left to right: drop oldest → compress (summarize) → stop. */
export const OVERFLOW_ORDER: readonly ContextOverflow[] = ['truncate', 'summarize', 'stop'];

/** A chat can also follow the user default (null), which sits left of the other steps. */
export type ChatOverflow = ContextOverflow | null;

export function overflowToIndex(v: ChatOverflow, withDefault: boolean): number {
  const i = v == null ? -1 : OVERFLOW_ORDER.indexOf(v);
  return withDefault ? i + 1 : Math.max(0, i);
}

export function indexToOverflow(i: number, withDefault: boolean): ChatOverflow {
  const j = Math.round(i) - (withDefault ? 1 : 0);
  if (j < 0) return withDefault ? null : OVERFLOW_ORDER[0];
  return OVERFLOW_ORDER[Math.min(j, OVERFLOW_ORDER.length - 1)];
}

/** Compress-start slider: 50..95 is a percentage, 100 means "off" (stored as null). */
export const COMPRESS_AT_OFF = 100;
export const compressAtToSlider = (v: number | null | undefined): number => (v == null ? COMPRESS_AT_OFF : v);
export const sliderToCompressAt = (n: number): number | null => (n >= COMPRESS_AT_OFF ? null : Math.max(50, Math.min(95, Math.round(n))));
