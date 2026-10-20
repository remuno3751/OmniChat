import React, { useState } from 'react';
import { Platform, View } from 'react-native';
import { apiV4 } from '../apiV4';
import { ensureNotificationPermission } from '../notifications';
import { useT } from '../i18n';
import { patchSettingsLocal, useStore } from '../store';
import { Btn, Check, Field, Hint } from '../ui/kit';
import { toast } from '../ui/toast';

type NotifyKind = 'done' | 'approval' | 'error';
const KINDS: NotifyKind[] = ['done', 'approval', 'error'];
const DEFAULT_NOTIFY = { done: true, approval: true, error: true };

/** Browser Notification permission ('default' | 'granted' | 'denied') or 'unsupported'. */
function currentPermission(): string {
  if (Platform.OS !== 'web') return 'unsupported';
  try {
    const N: any = (globalThis as any).Notification;
    return typeof N === 'function' ? String(N.permission) : 'unsupported';
  } catch {
    return 'unsupported';
  }
}

/** Settings > Code > Notifications: which events notify, the ntfy-style push URL, a test, browser permission. */
export default function NotifySettings() {
  const tr = useT();
  const settings = useStore((s) => s.settings);
  const notify = { ...DEFAULT_NOTIFY, ...(settings?.notify || {}) };
  const [urlDraft, setUrlDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [perm, setPerm] = useState(currentPermission);

  const toggle = async (k: NotifyKind, v: boolean) => {
    const next = { ...notify, [k]: v };
    setBusy(true);
    try {
      await apiV4.putNotify({ notify: next });
      patchSettingsLocal({ notify: next });
    } catch (e: any) {
      toast(e?.message || tr('code.saveFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  /** value = the new URL, or null to clear it. */
  const saveUrl = async (value: string | null) => {
    setBusy(true);
    try {
      await apiV4.putNotify({ notifyUrl: value });
      patchSettingsLocal({ notifyUrlSet: !!value });
      setUrlDraft('');
      toast(tr(value ? 'code.notifyUrlSaved' : 'code.notifyUrlCleared'), 'ok');
    } catch (e: any) {
      toast(e?.message || tr('code.saveFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      await apiV4.notifyTest();
      toast(tr('code.notifyTestOk'), 'ok');
    } catch (e: any) {
      toast(e?.message || tr('code.notifyTestFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const enableBrowser = async () => {
    setPerm(await ensureNotificationPermission());
  };

  return (
    <View style={{ gap: 4 }}>
      {KINDS.map((k) => (
        <Check
          key={k}
          label={tr(`code.notify${k[0].toUpperCase()}${k.slice(1)}`)}
          value={notify[k]}
          onChange={(v) => { void toggle(k, v); }}
        />
      ))}

      <View style={{ marginTop: 10, gap: 6 }}>
        <Field
          label={tr('code.notifyUrl')}
          value={urlDraft}
          onChangeText={setUrlDraft}
          placeholder={settings?.notifyUrlSet && !urlDraft ? tr('code.notifyUrlSet') : tr('code.notifyUrlPlaceholder')}
          secure
        />
        <Hint>{tr('code.notifyUrlHint')}</Hint>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
          <Btn label={tr('common.save')} primary onPress={() => { void saveUrl(urlDraft.trim() || null); }} disabled={busy} />
          <Btn label={tr('code.notifyClear')} onPress={() => { void saveUrl(null); }} disabled={busy || !settings?.notifyUrlSet} />
          <Btn label={tr('code.notifyTest')} onPress={() => { void test(); }} disabled={busy || !settings?.notifyUrlSet} />
        </View>
      </View>

      {Platform.OS === 'web' && (
        <View style={{ marginTop: 14, gap: 6 }}>
          <Btn
            label={tr('code.browserNotify')}
            onPress={() => { void enableBrowser(); }}
            disabled={perm === 'unsupported' || perm === 'granted'}
          />
          <Hint>{perm === 'unsupported' ? tr('code.browserUnsupported') : tr('code.browserPerm', { perm })}</Hint>
        </View>
      )}
    </View>
  );
}
