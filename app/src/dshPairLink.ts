// Deep link for the DeepSeek Harness pairing code: http://host/#dsh-pair=<code>
// The code is read from location.hash once, removed from the URL immediately, and held in memory
// only (never logged, toasted, or persisted here). The DSH integration card takes it via takePendingDshPair().

const PARAM = 'dsh-pair';
const CODE_RE = /^[A-Za-z0-9_-]{32,200}$/;

let pending: string | null = null;

/**
 * Reads and removes the dsh-pair param from location.hash. Other hash params are kept.
 * Returns the code when it is plausible, otherwise null. The param is removed even when invalid.
 */
export function consumeDshPairFromHash(): string | null {
  if (typeof window === 'undefined' || !window.location || !window.history) return null;
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return null;

  const parts = raw.split('&').filter((p) => p.length > 0);
  let code: string | null = null;
  let found = false;
  const kept: string[] = [];
  for (const part of parts) {
    if (part === PARAM || part.startsWith(`${PARAM}=`)) {
      if (!found) {
        found = true;
        const value = part.slice(PARAM.length + 1);
        try {
          const decoded = decodeURIComponent(value);
          code = CODE_RE.test(decoded) ? decoded : null;
        } catch {
          code = null;
        }
      }
      continue;
    }
    kept.push(part);
  }
  if (!found) return null;

  const nextHash = kept.length ? `#${kept.join('&')}` : '';
  try {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${nextHash}`);
  } catch {
    /* history unavailable: the code is still taken below */
  }
  return code;
}

/** Returns the pending pairing code once (then null). */
export function takePendingDshPair(): string | null {
  const v = pending;
  pending = null;
  return v;
}

/** True while a pairing code from the link has not been taken yet. */
export function peekHasPendingDshPair(): boolean {
  return pending !== null;
}

// Runs at import time so the code leaves the URL before anything else reads it.
// index.ts imports this module first.
pending = consumeDshPairFromHash();
