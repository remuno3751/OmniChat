// Hands text from the Tips sheet to the chat composer. Pure module (no React, no RN imports).
// If no composer is subscribed when text is requested, the text is kept as pending until a composer takes it.

type Listener = (text: string) => void;

const listeners = new Set<Listener>();
let pending: string | null = null;

/** Sends `text` to the subscribed composer, or keeps it pending when none is subscribed. */
export function requestComposerInsert(text: string): void {
  if (listeners.size === 0) {
    pending = text;
    return;
  }
  for (const cb of [...listeners]) cb(text);
}

/** Subscribes to insert requests. Returns the unsubscribe function. */
export function onComposerInsert(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Returns the pending text (or null) and clears it. */
export function takePendingInsert(): string | null {
  const out = pending;
  pending = null;
  return out;
}
