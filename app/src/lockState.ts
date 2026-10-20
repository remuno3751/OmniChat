/**
 * Background lock: decides when leaving the app (home button, app switcher, screen off) locks it again.
 * Pure (clock and callbacks are injected) so it can be unit-tested with node.
 *
 * The OS authentication dialog makes the app go 'inactive' or 'background' on some devices. Those events are
 * ignored while the dialog is showing and for `authGraceMs` after it closed; otherwise the dialog would lock
 * the app that it is just unlocking, and the prompt would open again in a loop.
 */

export type AppStateName = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';

export interface BackgroundLockOptions {
  now: () => number;
  /** false = never lock (lock off, or a platform where it does not apply) */
  isEnabled: () => boolean;
  /** seconds in the background before the lock engages; 0 = at once */
  delaySeconds: () => number;
  /** engage the lock (forget the unlock). Must be idempotent. */
  onLock: () => void;
  /** events this long after the auth dialog closed are still attributed to it */
  authGraceMs?: number;
}

export interface BackgroundLock {
  onAppState(next: AppStateName): void;
  authBegin(): void;
  authEnd(): void;
}

export const AUTH_GRACE_MS = 1500;

export function createBackgroundLock(o: BackgroundLockOptions): BackgroundLock {
  const grace = o.authGraceMs ?? AUTH_GRACE_MS;
  let leftAt: number | null = null;
  let authDepth = 0;
  let authEndedAt = -Infinity;

  return {
    authBegin() { authDepth++; },
    authEnd() { authDepth = Math.max(0, authDepth - 1); authEndedAt = o.now(); },
    onAppState(next) {
      const t = o.now();
      if (next === 'background' || next === 'inactive') {
        if (!o.isEnabled()) return;
        if (authDepth > 0 || t - authEndedAt < grace) return; // the auth dialog, not the user
        if (leftAt === null) leftAt = t;
        if (o.delaySeconds() <= 0) o.onLock(); // lock while leaving, so the app switcher shows the lock
        return;
      }
      if (next === 'active') {
        if (leftAt === null) return;
        const away = t - leftAt;
        leftAt = null;
        if (o.isEnabled() && away >= o.delaySeconds() * 1000) o.onLock();
      }
    },
  };
}
