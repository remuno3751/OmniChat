/**
 * Code lock: the authentication gate in front of the Code screens (remote control of the PC's DSH).
 * Pure logic lives here (no React / native imports) so it can be unit-tested with node. The stored shape is
 * `codeLock` in the per-device settings (never synced to the server). `unlockedAt` is memory only.
 */

/** Seconds after the last unlock before Code asks again. 0 = every time, -1 = until the app is closed. */
export const RELOCK_OPTIONS = [0, 60, 300, 900, -1] as const;
export type RelockSeconds = (typeof RELOCK_OPTIONS)[number];

/** What the lock covers: nothing, the Code screens only, or the whole app after login. */
export const LOCK_SCOPES = ['off', 'code', 'app'] as const;
export type LockScope = (typeof LOCK_SCOPES)[number];

/** Seconds the app may stay in the background before the lock engages again. 0 = at once. */
export const BACKGROUND_LOCK_OPTIONS = [0, 60, 300, 900] as const;

export interface CodeLockSettings {
  scope: LockScope;
  /** how long the app may be in the background (or the screen off) before the lock engages; 0 = immediately */
  backgroundLockSeconds: number;
  relockSeconds: number;
  /** hex salt for the app PIN, null when no PIN is set */
  pinSalt: string | null;
  /** hex SHA-256 (iterated) of the PIN, null when no PIN is set */
  pinHash: string | null;
  /** desktop (Mac / Windows): also offer fingerprint / face / Windows Hello; the PIN always stays as the fallback */
  biometric: boolean;
  /** consecutive wrong PIN entries */
  failCount: number;
  /** epoch ms until which PIN entry is refused (0 = not locked out) */
  lockedUntil: number;
}

export const CODE_LOCK_DEFAULTS: CodeLockSettings = {
  scope: 'code',
  backgroundLockSeconds: 0,
  relockSeconds: 300,
  pinSalt: null,
  pinHash: null,
  biometric: false,
  failCount: 0,
  lockedUntil: 0,
};

/** Patch that removes the PIN and its lockout state (used on logout). */
export const CODE_LOCK_PIN_CLEARED: Partial<CodeLockSettings> = {
  pinSalt: null,
  pinHash: null,
  biometric: false,
  failCount: 0,
  lockedUntil: 0,
};

/** Normalizes a stored or partial `codeLock` value. Broken or missing fields fall back to the defaults. */
export function normalizeCodeLock(raw: any): CodeLockSettings {
  const d = CODE_LOCK_DEFAULTS;
  const r = raw && typeof raw === 'object' ? raw : {};
  const salt = typeof r.pinSalt === 'string' && /^[0-9a-f]{32}$/.test(r.pinSalt) ? r.pinSalt : null;
  const hash = typeof r.pinHash === 'string' && /^[0-9a-f]{64}$/.test(r.pinHash) ? r.pinHash : null;
  const paired = salt !== null && hash !== null;
  return {
    // settings saved before `scope` existed have a boolean `enabled`: true = Code only, false = off
    scope: (LOCK_SCOPES as readonly string[]).includes(r.scope) ? r.scope
      : typeof r.enabled === 'boolean' ? (r.enabled ? 'code' : 'off') : d.scope,
    backgroundLockSeconds: (BACKGROUND_LOCK_OPTIONS as readonly number[]).includes(r.backgroundLockSeconds)
      ? r.backgroundLockSeconds : d.backgroundLockSeconds,
    relockSeconds: (RELOCK_OPTIONS as readonly number[]).includes(r.relockSeconds) ? r.relockSeconds : d.relockSeconds,
    pinSalt: paired ? salt : null,
    pinHash: paired ? hash : null,
    // biometrics only ever add to a PIN, so they count only while a PIN exists
    biometric: r.biometric === true && paired,
    failCount: typeof r.failCount === 'number' && Number.isInteger(r.failCount) && r.failCount >= 0 && r.failCount <= 100000
      ? r.failCount : d.failCount,
    lockedUntil: typeof r.lockedUntil === 'number' && Number.isFinite(r.lockedUntil) && r.lockedUntil > 0 ? r.lockedUntil : d.lockedUntil,
  };
}

export interface UnlockCheck {
  enabled: boolean;
  relockSeconds: number;
  /** epoch ms of the last successful unlock in this app run, null if none */
  unlockedAt: number | null;
  now: number;
  /** epoch ms when this app run started */
  appSessionStart: number;
}

/**
 * True when the Code screens must ask for authentication now.
 * - lock off: never
 * - never unlocked in this run: always
 * - 0: every time (each entry, and each return from the background)
 * - -1: only once per app run
 * - n seconds: when more than n seconds passed since the last unlock
 */
export function shouldRequireUnlock(c: UnlockCheck): boolean {
  if (!c.enabled) return false;
  if (c.unlockedAt === null || c.unlockedAt === undefined) return true;
  if (c.relockSeconds === -1) return c.unlockedAt < c.appSessionStart;
  if (c.relockSeconds === 0) return true;
  return c.now - c.unlockedAt > c.relockSeconds * 1000;
}

/** Wait after the n-th consecutive failure: 0 below 5; 5 -> 30 s, then doubling, capped at 15 min. */
export function lockoutMs(failCount: number): number {
  if (failCount < 5) return 0;
  return Math.min(15 * 60 * 1000, 30 * 1000 * Math.pow(2, failCount - 5));
}

/** The failure counter and lockout after one more wrong PIN at time `now`. */
export function afterFailure(prev: { failCount: number }, now: number): { failCount: number; lockedUntil: number } {
  const failCount = prev.failCount + 1;
  const ms = lockoutMs(failCount);
  return { failCount, lockedUntil: ms > 0 ? now + ms : 0 };
}

/** Milliseconds still to wait before a PIN may be entered (0 = may enter now). */
export function lockoutRemainingMs(lockedUntil: number, now: number): number {
  return Math.max(0, lockedUntil - now);
}

// ---- memory-only unlock state -------------------------------------------------------------------

/** Start time of this app run. A relock option of -1 keeps the unlock for as long as this run lasts. */
export const APP_SESSION_START = Date.now();

let unlockedAt: number | null = null;

export function getUnlockedAt(): number | null {
  return unlockedAt;
}

export function markUnlocked(now: number): void {
  unlockedAt = now;
  for (const l of [...listeners]) l(); // lists that hide Code titles while locked show them again
}

/** Forgets the unlock (logout, or the lock was turned on again). */
export function forgetUnlock(): void {
  unlockedAt = null;
  for (const l of [...listeners]) l();
}

const listeners = new Set<() => void>();

/** Called whenever the unlock changes (forgotten by the background lock or logout, or granted), so open gates and lists re-check at once. */
export function subscribeForget(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
