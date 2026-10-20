/** Picks up to `max` of `n` positions spread evenly over the whole range (always the first and the last one). */
export function sampleEvenly(n: number, max: number): number[] {
  if (n <= 0 || max <= 0) return [];
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  if (max === 1) return [n - 1];
  const out: number[] = [];
  for (let k = 0; k < max; k++) out.push(Math.round((k * (n - 1)) / (max - 1)));
  return out;
}

/**
 * Whether a revealed chunk still gets particle markers. Chunks live `lifeMs`, but the newest `keepNewest` always stay:
 * when a render is late (a long answer being re-parsed, a busy frame) the effect must not expire before it was ever drawn.
 */
export function chunkAlive(ageMs: number, indexFromNewest: number, lifeMs: number, keepNewest = 2): boolean {
  return ageMs <= lifeMs || indexFromNewest < keepNewest;
}
