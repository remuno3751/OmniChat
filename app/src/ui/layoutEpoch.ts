import { useEffect, useRef, useState } from 'react';

/** A window-width change this large (px) is a real resize (fold/unfold, rotation, split-screen), not insets/scrollbar jitter. */
export const RESIZE_THRESHOLD = 48;

/** true when the window width moved enough that cached native layout (Fabric/Yoga) may be stale. Pure, unit-tested. */
export function isRealResize(prevWidth: number, nextWidth: number, threshold = RESIZE_THRESHOLD): boolean {
  if (!Number.isFinite(prevWidth) || !Number.isFinite(nextWidth)) return false;
  return Math.abs(nextWidth - prevWidth) >= threshold;
}

/**
 * Returns a counter that increments once the window width has SETTLED after a real resize (debounced, so dragging a
 * split-screen divider does not remount on every frame). Use it as a React `key` on the message list: on Android
 * foldables the native layout of some rows can stay computed for the old window size (mixed widths, overlapping
 * rows); a fresh subtree is laid out from scratch against the current size.
 */
export function useLayoutEpoch(width: number, settleMs = 150): number {
  const [epoch, setEpoch] = useState(0);
  const applied = useRef(width);
  useEffect(() => {
    if (!isRealResize(applied.current, width)) return;
    const id = setTimeout(() => { applied.current = width; setEpoch((n) => n + 1); }, settleMs);
    return () => clearTimeout(id);
  }, [width, settleMs]);
  return epoch;
}
