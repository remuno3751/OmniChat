/**
 * Biometric unlock on the Mac / Windows desktop app (Touch ID, Windows Hello). The desktop shell exposes
 * `window.__OMNICHAT_DESKTOP__.biometricAvailable / biometricVerify`; everywhere else this reports "not available".
 * It only ever adds a faster way in: the app PIN stays the fallback.
 */
import { Platform } from 'react-native';
import { backgroundLock } from './appLock';

interface Bridge {
  biometricAvailable?: () => Promise<{ available: boolean; kind?: string }>;
  biometricVerify?: (reason: string) => Promise<{ ok: boolean; error?: string }>;
}

const bridge = (): Bridge | undefined =>
  Platform.OS === 'web' && typeof window !== 'undefined' ? (window as any).__OMNICHAT_DESKTOP__ : undefined;

/** True when this build can ask the desktop shell about biometrics at all. */
export const desktopBioSupported = (): boolean => typeof bridge()?.biometricAvailable === 'function';

let cached: Promise<{ available: boolean; kind: string }> | null = null;

/** Whether the machine can verify the user now (hardware present and enrolled). Cached per app run once positive. */
export function desktopBioAvailable(): Promise<{ available: boolean; kind: string }> {
  const b = bridge();
  if (!b?.biometricAvailable) return Promise.resolve({ available: false, kind: 'none' });
  if (!cached) {
    cached = b.biometricAvailable()
      .then((r) => ({ available: r?.available === true, kind: typeof r?.kind === 'string' ? r.kind : 'none' }))
      .catch(() => ({ available: false, kind: 'none' }));
    void cached.then((r) => { if (!r.available) cached = null; });
  }
  return cached;
}

/** Shows the OS prompt. Resolves true only on success; cancel, failure and errors resolve false. */
export async function desktopBioVerify(reason: string): Promise<boolean> {
  const b = bridge();
  if (!b?.biometricVerify) return false;
  backgroundLock.authBegin();
  try {
    const r = await b.biometricVerify(reason);
    return r?.ok === true;
  } catch {
    return false;
  } finally {
    backgroundLock.authEnd();
  }
}
