/**
 * "Is this message new?" for the entry animation (pure; used by MessageView / ChatScreen).
 * Message createdAt is stamped by the SERVER, but Date.now() is the PHONE clock: a few seconds of skew made every message
 * look old (age >= 4 s) so nothing animated. We therefore also track what this client saw arrive: a message that appears in
 * the open conversation after the first render, and is newer than everything that was shown at open, is fresh whatever the clocks say.
 */
export const FRESH_MS = 4000;

/** Legacy same-clock test (locally created messages, or phone and server in sync). */
export function freshByClock(createdAt: number, now: number): boolean {
  return now - createdAt < FRESH_MS;
}

export interface FreshTracker {
  /** Feed the current message path on every render (idempotent). Resets itself when convId changes. */
  observe(convId: string, msgs: { id: string; createdAt: number }[]): void;
  /** true when the message arrived after the conversation was opened and is newer (by its own server stamp) than what was there at open */
  isLate(id: string, createdAt: number): boolean;
}

export function createFreshTracker(): FreshTracker {
  let conv: string | null = null;
  let initial = new Set<string>();
  let newest = 0;
  let late = new Set<string>();
  let primed = false;
  return {
    observe(convId, msgs) {
      if (convId !== conv) { conv = convId; initial = new Set(msgs.map((m) => m.id)); newest = msgs.reduce((a, m) => Math.max(a, m.createdAt), 0); late = new Set(); primed = true; return; }
      if (!primed) return;
      for (const m of msgs) if (!initial.has(m.id) && m.createdAt > newest) late.add(m.id);
    },
    isLate(id, createdAt) { return late.has(id) && !initial.has(id) && createdAt > newest; },
  };
}

/** Final decision made once at MessageView mount. */
export function isFreshMessage(createdAt: number, now: number, late: boolean): boolean {
  return late || freshByClock(createdAt, now);
}
