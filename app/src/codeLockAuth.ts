import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { backgroundLock } from './appLock';

/** 'os' = the OS prompt (fingerprint / face / device PIN); 'pin' = the app's own PIN. */
export type LockMethod = 'os' | 'pin';

let detected: Promise<LockMethod> | null = null;

/**
 * Picks the method once per app run. OS authentication needs hardware, an enrolled biometric or device
 * credential, and a security level above NONE. Web (and the Tauri launcher, which opens the web UI) always uses the PIN.
 */
export function detectLockMethod(): Promise<LockMethod> {
  if (!detected) {
    detected = (async (): Promise<LockMethod> => {
      if (Platform.OS === 'web') return 'pin';
      try {
        const hw = await LocalAuthentication.hasHardwareAsync();
        const enrolled = await LocalAuthentication.isEnrolledAsync();
        const level = await LocalAuthentication.getEnrolledLevelAsync();
        return hw && enrolled && level !== LocalAuthentication.SecurityLevel.NONE ? 'os' : 'pin';
      } catch {
        return 'pin';
      }
    })();
  }
  return detected;
}

/** The detected method, or null while detection runs. */
export function useLockMethod(): LockMethod | null {
  const [m, setM] = useState<LockMethod | null>(null);
  useEffect(() => {
    let alive = true;
    void detectLockMethod().then((v) => { if (alive) setM(v); });
    return () => { alive = false; };
  }, []);
  return m;
}

/** Runs the OS authentication prompt. Resolves true only on success; cancel, failure and errors resolve false. */
export async function osAuthenticate(promptMessage: string): Promise<boolean> {
  // the prompt can make the app 'inactive'; tell the background lock so it does not lock (and loop)
  backgroundLock.authBegin();
  try {
    const r = await LocalAuthentication.authenticateAsync({ promptMessage, disableDeviceFallback: false });
    return r.success === true;
  } catch {
    return false;
  } finally {
    backgroundLock.authEnd();
  }
}
