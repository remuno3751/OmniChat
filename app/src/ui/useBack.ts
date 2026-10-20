import { useEffect, useRef } from 'react';
import { BackHandler, Platform } from 'react-native';
import { registerBack, runBack } from '../backHandler';

/**
 * Registers `onBack` with the back registry while `active` (see backHandler.ts for the priorities).
 * The latest `onBack` is kept in a ref, so re-renders neither re-register nor reorder the handler.
 */
export function useBack(active: boolean, priority: number, onBack: () => boolean | void): void {
  const ref = useRef(onBack);
  ref.current = onBack;
  useEffect(() => {
    if (!active) return;
    return registerBack(priority, () => ref.current());
  }, [active, priority]);
}

/**
 * Android only: routes the hardware back button / back gesture into the back registry.
 * Always consumes the press (returns true), so the OS never closes the app directly; the ROOT handler decides.
 */
export function useAndroidBackBridge(): void {
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      runBack();
      return true;
    });
    return () => sub.remove();
  }, []);
}
