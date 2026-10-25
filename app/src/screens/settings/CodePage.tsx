import React, { useEffect, useState } from 'react';
import ApprovalRules from '../../components/ApprovalRules';
import { LockPrompt } from '../../components/CodeLockGate';
import { BACKGROUND_LOCK_OPTIONS, RELOCK_OPTIONS, markUnlocked } from '../../codeLock';
import type { LockScope } from '../../codeLock';
import { setDevice, useDevice } from '../../deviceSettings';
import { Platform } from 'react-native';
import { useLockMethod } from '../../codeLockAuth';
import { desktopBioAvailable, desktopBioVerify } from '../../desktopBio';
import { useT } from '../../i18n';
import { Btn, Check, Hint, Segmented, Sheet } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { PageFrame, Section } from './common';

const RELOCK_LABEL: Record<number, string> = {
  0: 'codelock.relock.every',
  60: 'codelock.relock.1m',
  300: 'codelock.relock.5m',
  900: 'codelock.relock.15m',
  [-1]: 'codelock.relock.app',
};

const BG_LABEL: Record<number, string> = {
  0: 'codelock.bg.now',
  60: 'codelock.relock.1m',
  300: 'codelock.relock.5m',
  900: 'codelock.relock.15m',
};

const SCOPE_RANK: Record<LockScope, number> = { off: 0, code: 1, app: 2 };

/** Settings > Code: approval rules and notifications, then the Code lock. */
export default function CodePage({ onBack, onLogout }: { onBack: () => void; onLogout: () => void }) {
  const tr = useT();
  return (
    <PageFrame title={tr('settings.page.code')} onBack={onBack}>
      <Section title={tr('code.rules')} first />
      <ApprovalRules />
      <Section title={tr('code.notify')} />
      <Section title={tr('codelock.title')} />
      <CodeLockSection onLogout={onLogout} />
    </PageFrame>
  );
}

/**
 * The lock scope (none / Code only / whole app), the timing and the PIN. Lowering the scope, and changing the
 * PIN, need an authentication first (a sheet that reuses the gate's prompt). Raising it needs none.
 */
function CodeLockSection({ onLogout }: { onLogout: () => void }) {
  const tr = useT();
  const lock = useDevice((s) => s.codeLock);
  const method = useLockMethod();
  /** 'lower' = lower the scope to `target`; 'change' = change the PIN; stage 'unlock' verifies first, 'setup' chooses a PIN */
  const [sheet, setSheet] = useState<null | 'lower' | 'change'>(null);
  const [target, setTarget] = useState<LockScope>('off');
  const [stage, setStage] = useState<'unlock' | 'setup'>('unlock');

  const openSheet = (k: 'lower' | 'change') => {
    setSheet(k);
    // no PIN yet (PIN method): the only credential there is must be created first
    setStage(method === 'pin' && lock.pinHash === null ? 'setup' : 'unlock');
  };

  const finish = () => {
    if (sheet === 'lower') {
      setDevice({ codeLock: { scope: target } });
      setSheet(null);
      return;
    }
    if (stage === 'unlock' && method === 'pin') { setStage('setup'); return; }
    setSheet(null);
  };

  // desktop biometrics (Touch ID / Windows Hello): offered only when the shell reports them available
  const [bio, setBio] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void desktopBioAvailable().then((r) => { if (alive && r.available) setBio(r.kind); });
    return () => { alive = false; };
  }, []);
  const toggleBio = async (on: boolean) => {
    // turning it on proves once that it works, so the user is never locked into a prompt that cannot succeed
    if (on && !(await desktopBioVerify(tr('codelock.bioEnable')))) { toast(tr('codelock.bioFailed'), 'error'); return; }
    setDevice({ codeLock: { biometric: on } });
  };

  const pickScope = (next: LockScope) => {
    if (next === lock.scope || method === null) return;
    if (SCOPE_RANK[next] < SCOPE_RANK[lock.scope]) { setTarget(next); openSheet('lower'); return; }
    setDevice({ codeLock: { scope: next } });
    // the user is in the app right now: do not lock them out of the settings they are on
    if (next === 'app') markUnlocked(Date.now());
    if (method === 'pin' && lock.pinHash === null) openSheet('change');
  };

  const scopeLabel: Record<LockScope, string> = { off: 'codelock.scope.off', code: 'codelock.scope.code', app: 'codelock.scope.app' };

  return (
    <>
      <Hint>{tr('codelock.scopeLabel')}</Hint>
      <Segmented
        options={(['off', 'code', 'app'] as const).map((v) => ({ value: v, label: tr(scopeLabel[v]) }))}
        value={lock.scope}
        onChange={pickScope}
      />
      <Hint>{tr('codelock.enableHint')}</Hint>
      {lock.scope !== 'off' && (
        <>
          {lock.scope === 'code' && (
            <>
              <Hint>{tr('codelock.relockLabel')}</Hint>
              <Segmented
                options={RELOCK_OPTIONS.map((v) => ({ value: String(v), label: tr(RELOCK_LABEL[v]) }))}
                value={String(lock.relockSeconds)}
                onChange={(v) => setDevice({ codeLock: { relockSeconds: Number(v) } })}
              />
            </>
          )}
          {Platform.OS !== 'web' && (
            <>
              <Hint>{tr('codelock.bgLabel')}</Hint>
              <Segmented
                options={BACKGROUND_LOCK_OPTIONS.map((v) => ({ value: String(v), label: tr(BG_LABEL[v]) }))}
                value={String(lock.backgroundLockSeconds)}
                onChange={(v) => setDevice({ codeLock: { backgroundLockSeconds: Number(v) } })}
              />
            </>
          )}
          {method === 'pin' && (
            <Btn
              label={tr(lock.pinHash === null ? 'codelock.pinSet' : 'codelock.pinChange')}
              onPress={() => openSheet('change')}
              small
            />
          )}
          {method === 'pin' && bio && lock.pinHash !== null && (
            <Check label={tr('codelock.bio', { kind: tr(bio === 'touchid' ? 'codelock.bio.touchid' : 'codelock.bio.hello') })} hint={tr('codelock.bioHint')} value={lock.biometric} onChange={toggleBio} />
          )}
          {method === 'os' && <Hint>{tr('codelock.osNote')}</Hint>}
          <Hint>{tr('codelock.recoveryNote')}</Hint>
        </>
      )}
      <Sheet
        visible={sheet !== null}
        onClose={() => setSheet(null)}
        title={tr(sheet === 'lower' ? 'codelock.offTitle' : lock.pinHash === null ? 'codelock.pinSet' : 'codelock.pinChange')}
      >
        {sheet !== null && method !== null && (
          <LockPrompt
            key={`${sheet}-${stage}`}
            method={method}
            mode={stage}
            onDone={finish}
            onLogout={stage === 'unlock' ? onLogout : undefined}
          />
        )}
      </Sheet>
    </>
  );
}
