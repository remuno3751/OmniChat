/**
 * Reveal scheduling for "Smooth" streaming text (pure; the rAF loop lives in ui/streamText.ts).
 * Characters are released at an adaptive rate: a floor so it never stalls, plus a share of the backlog
 * so a growing buffer is caught up faster (backlog drains with a time constant of CATCHUP_MS).
 */
export const MIN_CPS = 45;
export const CATCHUP_MS = 280;
/** Past this backlog everything beyond it is shown at once (e.g. the tab was in the background). */
export const MAX_BACKLOG = 1500;

const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** Pulls `n` off a UTF-16 index so it never splits a surrogate pair. */
export function safeCut(text: string, n: number): number {
  if (n > 0 && n < text.length && isLow(text.charCodeAt(n))) return n + 1;
  return n;
}

/**
 * Next number of revealed UTF-16 units.
 * `shown` = revealed now, `total` = text length, `dtMs` = time since the last step, `carry` = fractional chars owed.
 * Returns `{ shown, carry }`. Always makes progress (>=1 char per step) while there is a backlog and dt > 0.
 */
export function stepReveal(text: string, shown: number, dtMs: number, carry = 0): { shown: number; carry: number } {
  const total = text.length;
  if (shown >= total) return { shown: total, carry: 0 };
  let backlog = total - shown;
  if (backlog > MAX_BACKLOG) { shown = safeCut(text, total - MAX_BACKLOG); backlog = MAX_BACKLOG; }
  const dt = Math.max(0, Math.min(dtMs, 100)); // a long frame must not dump the buffer
  const cps = MIN_CPS + (backlog * 1000) / CATCHUP_MS;
  const owed = carry + (cps * dt) / 1000;
  let n = Math.floor(owed);
  if (n < 1 && dt > 0) n = 1; // never stall
  n = Math.min(n, backlog);
  const next = safeCut(text, shown + n);
  return { shown: Math.min(next, total), carry: Math.max(0, owed - n) };
}
