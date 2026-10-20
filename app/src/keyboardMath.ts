/**
 * Pure math for soft-keyboard avoidance (see ui/safe.tsx). All values are in window pixels (same coordinate space as
 * View.measureInWindow and the Keyboard event's endCoordinates.screenY).
 */

/**
 * How far the keyboard covers the bottom of a container: container bottom edge minus keyboard top edge, never negative.
 * Self-correcting: if the OS already shrank the window (adjustResize) the container bottom is already at/above the
 * keyboard top, so this returns 0 and nothing is compensated twice.
 */
export function keyboardOverlap(containerBottomY: number, keyboardTopY: number | null | undefined): number {
  if (keyboardTopY == null || !Number.isFinite(keyboardTopY) || !Number.isFinite(containerBottomY)) return 0;
  return Math.max(0, Math.round(containerBottomY - keyboardTopY));
}

/**
 * Bottom padding of a keyboard-avoiding container. With the keyboard shown the keyboard itself covers the gesture / navigation
 * bar, so the bottom safe-area inset is dropped and only the overlap is compensated; otherwise the inset (+ extra) applies.
 */
export function avoidPadding(opts: { keyboardVisible: boolean; overlap: number; insetBottom: number; rest?: number }): number {
  const rest = opts.rest ?? 0;
  if (!opts.keyboardVisible) return Math.max(0, opts.insetBottom) + rest;
  return Math.max(0, opts.overlap);
}

/** Insets as plain numbers (web / unknown → 0). */
export interface Insets { top: number; bottom: number; left: number; right: number }
export const ZERO_INSETS: Insets = { top: 0, bottom: 0, left: 0, right: 0 };
