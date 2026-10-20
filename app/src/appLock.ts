import { AppState, Platform } from 'react-native';
import { getDevice } from './deviceSettings';
import { forgetUnlock } from './codeLock';
import { createBackgroundLock } from './lockState';

/**
 * The app-wide background lock. Web / desktop builds do not lock on a hidden tab or window (switching tabs
 * is constant there); they keep the lock on load only.
 */
export const backgroundLock = createBackgroundLock({
  now: () => Date.now(),
  isEnabled: () => Platform.OS !== 'web' && getDevice().codeLock.scope !== 'off',
  delaySeconds: () => getDevice().codeLock.backgroundLockSeconds,
  onLock: forgetUnlock,
});

/** Listens to AppState for as long as the app is mounted. Returns the unsubscribe function. */
export function startBackgroundLock(): () => void {
  const sub = AppState.addEventListener('change', (s) => backgroundLock.onAppState(s));
  return () => sub.remove();
}
