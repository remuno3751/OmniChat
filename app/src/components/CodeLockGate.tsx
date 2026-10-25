import React, { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, Modal, StyleSheet, Text, View } from 'react-native';
import { getDevice, setDevice, useDevice } from '../deviceSettings';
import { useT } from '../i18n';
import { APP_SESSION_START, afterFailure, getUnlockedAt, lockoutRemainingMs, markUnlocked, shouldRequireUnlock, subscribeForget } from '../codeLock';
import { startBackgroundLock } from '../appLock';
import { hashPin, isValidPin, newSalt, verifyPin, PIN_MAX, PIN_MIN } from '../pinHash';
import { osAuthenticate, useLockMethod } from '../codeLockAuth';
import { desktopBioAvailable, desktopBioVerify } from '../desktopBio';
import type { LockMethod } from '../codeLockAuth';
import { confirmDialog } from '../ui/confirm';
import { useTheme } from '../theme';
import { Btn, Field, Hint } from '../ui/kit';

/** True when the Code screens must ask for authentication right now (the whole-app lock covers them itself). */
export function needsUnlock(): boolean {
  const c = getDevice().codeLock;
  return shouldRequireUnlock({
    enabled: c.scope === 'code',
    relockSeconds: c.relockSeconds,
    unlockedAt: getUnlockedAt(),
    now: Date.now(),
    appSessionStart: APP_SESSION_START,
  });
}

/** True when the whole-app lock must ask for authentication right now (once per run, and after a background lock). */
export function needsAppUnlock(): boolean {
  const c = getDevice().codeLock;
  return shouldRequireUnlock({
    enabled: c.scope === 'app',
    relockSeconds: -1,
    unlockedAt: getUnlockedAt(),
    now: Date.now(),
    appSessionStart: APP_SESSION_START,
  });
}

/**
 * Wraps the Code screens. While `active` and locked, the children are not rendered (so their data is not
 * fetched) and the authentication prompt is shown instead. Returning to the app and the relock timer
 * re-check the lock through `needsUnlock()`.
 */
export function CodeLockGate({ active, onLogout, children }: { active: boolean; onLogout: () => void; children: React.ReactNode }) {
  const method = useLockMethod();
  const pinSet = useDevice((s) => s.codeLock.pinHash !== null);
  const relock = useDevice((s) => s.codeLock.relockSeconds);
  const [locked, setLocked] = useState(() => active && needsUnlock());

  // Entering the Code screens: lock again if the relock rule says so.
  useEffect(() => {
    setLocked(active && needsUnlock());
  }, [active]);

  // Timed relock while the screen stays open (0 is handled on entry and on return; -1 never relocks in a run).
  useEffect(() => {
    if (!active || locked || relock <= 0) return;
    const id = setInterval(() => { if (needsUnlock()) setLocked(true); }, 5000);
    return () => clearInterval(id);
  }, [active, locked, relock]);

  // The background lock (appLock.ts) forgot the unlock, and logout does too: lock at once.
  useEffect(() => {
    if (!active) return;
    return subscribeForget(() => { if (needsUnlock()) setLocked(true); });
  }, [active]);

  if (!active || !locked) return <>{children}</>;
  if (method === null) return <LockedShell><ActivityIndicator /></LockedShell>;
  const setup = method === 'pin' && !pinSet;
  return (
    <LockedShell>
      <LockPrompt
        method={method}
        mode={setup ? 'setup' : 'unlock'}
        onDone={() => { markUnlocked(Date.now()); setLocked(false); }}
        onLogout={onLogout}
      />
    </LockedShell>
  );
}

/**
 * Wraps the whole signed-in app. With the "whole app" scope a full-screen modal covers every screen (and any
 * open dialog or sheet) while locked; the app underneath stays mounted so a running chat is not lost.
 * It also runs the background lock for both scopes.
 */
export function AppLockGate({ onLogout, children }: { onLogout: () => void; children: React.ReactNode }) {
  const method = useLockMethod();
  const scope = useDevice((s) => s.codeLock.scope);
  const pinSet = useDevice((s) => s.codeLock.pinHash !== null);
  const [locked, setLocked] = useState(() => needsAppUnlock());

  useEffect(() => startBackgroundLock(), []);
  useEffect(() => { setLocked(needsAppUnlock()); }, [scope]);
  useEffect(() => subscribeForget(() => { if (needsAppUnlock()) setLocked(true); }), []);

  return (
    <>
      {children}
      {locked && scope === 'app' && (
        <Modal visible animationType="none" statusBarTranslucent onRequestClose={() => {}}>
          <LockedShell title="applock.gateTitle">
            {method === null ? <ActivityIndicator /> : (
              <LockPrompt
                method={method}
                mode={method === 'pin' && !pinSet ? 'setup' : 'unlock'}
                osPromptKey="applock.osPrompt"
                onDone={() => { markUnlocked(Date.now()); setLocked(false); }}
                onLogout={onLogout}
              />
            )}
          </LockedShell>
        </Modal>
      )}
    </>
  );
}

function LockedShell({ children, title = 'codelock.gateTitle' }: { children: React.ReactNode; title?: string }) {
  const t = useTheme();
  const tr = useT();
  return (
    <View style={[styles.shell, { backgroundColor: t.bg }]}>
      <Text style={[styles.title, { color: t.text }]}>{tr(title)}</Text>
      {children}
    </View>
  );
}

/**
 * The authentication UI, shared by the gate and the settings sheets.
 * - unlock + os: OS prompt (opens at once); the PIN can be used instead when one is set.
 * - unlock + pin: PIN entry with the lockout countdown.
 * - setup: choose a PIN (4-8 digits, twice).
 * `onLogout` (optional) gives the way out when the PIN is forgotten.
 */
export function LockPrompt({ method, mode, onDone, onLogout, osPromptKey = 'codelock.osPrompt' }: {
  method: LockMethod; mode: 'unlock' | 'setup'; onDone: () => void; onLogout?: () => void; osPromptKey?: string;
}) {
  const tr = useT();
  const t = useTheme();
  const lock = useDevice((s) => s.codeLock);
  const [usePin, setUsePin] = useState(false);
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);

  const remain = lockoutRemainingMs(lock.lockedUntil, Date.now());
  useEffect(() => {
    if (remain <= 0) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [remain > 0]);

  // Desktop biometrics sit on top of the PIN: tried first when enabled, the PIN fields stay below as the fallback.
  const [bioOn, setBioOn] = useState(false);
  const runBio = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await desktopBioVerify(tr(osPromptKey));
    setBusy(false);
    if (ok) onDone();
    else setErr(tr('codelock.bioFailed'));
  };
  useEffect(() => {
    if (mode !== 'unlock' || method !== 'pin' || !lock.biometric || lock.pinHash === null) return;
    let alive = true;
    void desktopBioAvailable().then((r) => { if (alive && r.available) { setBioOn(true); void runBio(); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runOs = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await osAuthenticate(tr(osPromptKey));
    setBusy(false);
    if (ok) onDone();
    else setErr(tr('codelock.osFailed'));
  };

  // OS prompt opens by itself when the prompt appears. A lock that engaged while the app was leaving is
  // shown in the background: wait until the app is in front again (the OS prompt cannot show before that).
  useEffect(() => {
    if (mode !== 'unlock' || method !== 'os') return;
    if (AppState.currentState === 'active') { void runOs(); return; }
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') { sub.remove(); void runOs(); }
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitUnlock = () => {
    if (busy || remain > 0) return;
    const c = getDevice().codeLock;
    if (!c.pinSalt || !c.pinHash) return;
    setBusy(true);
    const good = verifyPin(pin, c.pinSalt, c.pinHash);
    setBusy(false);
    if (good) {
      setDevice({ codeLock: { failCount: 0, lockedUntil: 0 } });
      setPin('');
      onDone();
      return;
    }
    const next = afterFailure(c, Date.now());
    setDevice({ codeLock: next });
    setPin('');
    const wait = lockoutRemainingMs(next.lockedUntil, Date.now());
    setErr(wait > 0 ? `${tr('codelock.wrong')} ${tr('codelock.wait', { sec: Math.ceil(wait / 1000) })}` : tr('codelock.wrong'));
  };

  const submitSetup = () => {
    if (busy) return;
    if (!isValidPin(pin)) { setErr(tr('codelock.invalid')); return; }
    if (pin !== pin2) { setErr(tr('codelock.mismatch')); return; }
    setBusy(true);
    const salt = newSalt();
    const hash = hashPin(pin, salt);
    setDevice({ codeLock: { pinSalt: salt, pinHash: hash, failCount: 0, lockedUntil: 0 } });
    setBusy(false);
    setPin(''); setPin2('');
    onDone();
  };

  const logout = async () => {
    if (!onLogout) return;
    const ok = await confirmDialog(tr('codelock.resetConfirm'), tr('codelock.resetMessage'), tr(method === 'pin' ? 'codelock.reset' : 'codelock.logout'));
    // onLogout (App) clears the PIN and the unlock state as part of logging out.
    if (ok) onLogout();
  };

  const hasPin = lock.pinHash !== null;
  const showPin = mode === 'setup' || method === 'pin' || usePin;
  const logoutBtn = onLogout && mode === 'unlock'
    ? <Btn style={styles.wide} label={tr(method === 'pin' ? 'codelock.reset' : 'codelock.logout')} onPress={logout} small />
    : null;

  if (mode === 'unlock' && method === 'os' && !usePin) {
    return (
      <View style={styles.box}>
        <Btn style={styles.wide} label={tr('codelock.osRetry')} onPress={runOs} primary disabled={busy} />
        {!!err && <Hint danger>{err}</Hint>}
        {hasPin && <Btn style={styles.wide} label={tr('codelock.usePin')} onPress={() => { setErr(null); setUsePin(true); }} small />}
        {logoutBtn}
      </View>
    );
  }

  if (!showPin) return null;
  const waiting = mode === 'unlock' && remain > 0;
  return (
    <View style={styles.box}>
      {mode === 'setup' && <Text style={[styles.sub, { color: t.text }]}>{tr('codelock.setupTitle')}</Text>}
      {mode === 'setup' && <Hint>{tr('codelock.setupHint', { min: PIN_MIN, max: PIN_MAX })}</Hint>}
      <Field
        label={mode === 'setup' ? tr('codelock.pinNew') : tr('codelock.pinEnter')}
        value={pin}
        onChangeText={(v) => { setPin(v.replace(/\D/g, '').slice(0, PIN_MAX)); setErr(null); }}
        secure
        keyboardType="number-pad"
        autoFocus
        onSubmit={mode === 'setup' ? submitSetup : submitUnlock}
      />
      {mode === 'setup' && (
        <Field
          label={tr('codelock.pinConfirm')}
          value={pin2}
          onChangeText={(v) => { setPin2(v.replace(/\D/g, '').slice(0, PIN_MAX)); setErr(null); }}
          secure
          keyboardType="number-pad"
          onSubmit={submitSetup}
        />
      )}
      {waiting && <Hint danger>{tr('codelock.wait', { sec: Math.ceil(remain / 1000) })}</Hint>}
      {!!err && !waiting && <Hint danger>{err}</Hint>}
      <Btn
        label={tr(mode === 'setup' ? 'codelock.save' : 'codelock.unlock')}
        onPress={mode === 'setup' ? submitSetup : submitUnlock}
        primary
        disabled={busy || waiting || pin.length < PIN_MIN}
      />
      {mode === 'unlock' && bioOn && <Btn style={styles.wide} label={tr('codelock.bioRetry')} onPress={() => { setErr(null); void runBio(); }} disabled={busy} small />}
      {mode === 'unlock' && method === 'os' && <Btn style={styles.wide} label={tr('codelock.osRetry')} onPress={() => { setErr(null); setUsePin(false); void runOs(); }} small />}
      {logoutBtn}
    </View>
  );
}

const styles = StyleSheet.create({
  shell: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  title: { fontSize: 18, fontWeight: '600', marginBottom: 16 },

  box: { width: '100%', maxWidth: 360, gap: 8 },
  wide: { alignSelf: 'stretch' },
  sub: { fontSize: 15, fontWeight: '600' },
});
