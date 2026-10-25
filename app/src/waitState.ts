/** Pure helpers for the "waiting for the first token" status and the thinking duration label. */

export type WaitKey = 'wait.waiting' | 'wait.processing' | 'wait.slow';

/**
 * Stage of a reply that has no content and no reasoning yet.
 * 0-3 s: waiting for the response; 3-30 s: processing the prompt; 30 s and up: slow (model load / long input).
 * After tool activity the prompt is already processed, so only the "waiting" stage applies.
 */
export function waitStage(elapsedMs: number, hasToolActivity = false): { key: WaitKey; s: number } {
  const ms = Math.max(0, elapsedMs);
  const s = Math.floor(ms / 1000);
  if (hasToolActivity) return { key: 'wait.waiting', s };
  if (ms >= 30000) return { key: 'wait.slow', s };
  if (ms >= 3000) return { key: 'wait.processing', s };
  return { key: 'wait.waiting', s };
}

/**
 * Duration of the reasoning lane: from its first reasoning delta to its end (the first answer delta).
 * `endedAt` absent means still thinking, measured up to `now`. Returns null when the lane never started.
 */
export function thinkingMs(startedAt: number | null | undefined, endedAt: number | null | undefined, now: number): number | null {
  if (!startedAt) return null;
  return Math.max(0, (endedAt ?? now) - startedAt);
}
