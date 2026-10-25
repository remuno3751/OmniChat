import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, Platform, ScrollView, Text, View } from 'react-native';
import { api } from '../api';
import { useT } from '../i18n';
import { useStore } from '../store';
import { useTheme, useThemeDef } from '../theme';
import { Btn, Hint, Sheet } from '../ui/kit';
import { toast } from '../ui/toast';
import { decidePopup, failureDismissKey, serverVersionChanged } from '../updateState';
import { canInstallFromHere, isNativeUpdatePlatform, nextUpdatePollMs } from '../updateTypes';
import type { UpdateStatus } from '../updateTypes';
import {
  getDeviceUpdateState,
  loadDeviceUpdateState,
  remindLaterDeviceUpdate,
  setLastSeenServerVersion,
  setAvailableUpdateVersion,
  skipDeviceUpdate,
  useDeviceUpdate,
} from '../updateStore';
import { CopyBlock } from './IntegrationParts';
import { ApplyFailure, ApplyProgress, failureOf } from './UpdatesSection';
import { dismissApplyFailure, fetchServerVersion, isApplyActive, startApply, useApplyView } from './useApplyUpdate';

/** Web only: GET /version while the page is open (detects a server update made elsewhere). */
const VERSION_EVERY_MS = 60_000;
/** Characters of the release notes shown in the popup. */
const NOTES_PREVIEW = 600;

/**
 * Background checks for the update popup and the reload banner (one hook, mounted once with the popup):
 * - device state + GET /update/status on mount (login), then every 6 h, or 15 min after a failed load or a server error;
 * - web: GET /version every 60 s and on socket reconnect; a changed version shows the reload banner;
 * - the last seen server version is kept per device (lastSeenServerVersion) so a change made while the
 *   app was closed is noticed on the next start.
 * A failed load never shows the popup (it stays closed); the Settings > Updates section shows the error and a Retry.
 */
function useUpdateWatch() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  /** n counts finished loads; failed means the last load threw or the server reported lastError */
  const [poll, setPoll] = useState({ failed: false, n: 0 });
  const [serverChanged, setServerChanged] = useState(false);
  const connected = useStore((s) => s.connected);
  const apply = useApplyView();

  const refresh = useCallback(async () => {
    try {
      const s = await api.updateStatus();
      setStatus(s);
      setAvailableUpdateVersion(s.updateAvailable && s.latest && !s.skipped ? s.latest.version : null);
      const prev = getDeviceUpdateState().lastSeenServerVersion;
      if (!isApplyActive() && serverVersionChanged(prev, s.current)) setServerChanged(true);
      setLastSeenServerVersion(s.current);
      setPoll((p) => ({ failed: s.lastError !== null, n: p.n + 1 }));
    } catch {
      // offline, or not logged in any more: keep the last known status, retry in 15 min
      setPoll((p) => ({ failed: true, n: p.n + 1 }));
    }
  }, []);

  const checkVersion = useCallback(async () => {
    if (Platform.OS !== 'web' || isApplyActive()) return;
    const v = await fetchServerVersion();
    if (!v) return;
    if (serverVersionChanged(getDeviceUpdateState().lastSeenServerVersion, v)) {
      setLastSeenServerVersion(v);
      setServerChanged(true);
    }
  }, []);

  // mount (login): device state, then the status
  useEffect(() => {
    let alive = true;
    void loadDeviceUpdateState().finally(() => { if (alive) void refresh(); });
    return () => { alive = false; };
  }, [refresh]);

  // next status load: every 6 h, or 15 min after a failure (each finished load re-arms the timer)
  useEffect(() => {
    const h = setTimeout(() => { void refresh(); }, nextUpdatePollMs(poll.failed));
    return () => clearTimeout(h);
  }, [poll, refresh]);

  // web: version watch every 60 s
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const h = setInterval(() => { void checkVersion(); }, VERSION_EVERY_MS);
    return () => clearInterval(h);
  }, [checkVersion]);

  // socket (re)connected: the server may have restarted with a new version
  useEffect(() => {
    if (connected) { void checkVersion(); void refresh(); }
  }, [connected, checkVersion, refresh]);

  // an update started or ended: the status changed
  useEffect(() => { void refresh(); }, [apply.phase, refresh]);

  return { status, refresh, serverChanged, setServerChanged };
}

/**
 * Mounted once in App.tsx (logged-in state only). Shows, in order of priority:
 * the progress of a running update, a failed/rolled-back update (OK acknowledges it), the update popup
 * (admins only: Update now / Skip this version / Later), and on web a non-blocking reload banner.
 */
export default function UpdatePopup() {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const device = useDeviceUpdate();
  const apply = useApplyView();
  const { status, refresh, serverChanged, setServerChanged } = useUpdateWatch();
  /** dismissed for this app session only (closing the popup); the device state keeps the longer choices */
  const [dismissed, setDismissed] = useState<string[]>([]);

  const decision = useMemo(
    () => decidePopup({ status, device, now: Date.now(), isAdmin: !!status?.isAdmin, sessionDismissed: dismissed }),
    [status, device, dismissed],
  );

  const applyActive = isApplyActive(apply);
  const upd = decision.kind === 'update' ? status?.latest ?? null : null;
  // a failure of this session's apply (not yet dismissed) or a server failure from decidePopup
  const applyFailText = apply.phase === 'failed' && !dismissed.includes(failureDismissKey(apply.target ?? ''))
    ? failureOf(apply, status, tr)
    : null;
  const failureText = applyFailText ?? (decision.kind === 'failure' ? decision.message : null);
  const failureVersion = applyFailText !== null ? (apply.target ?? '') : decision.kind === 'failure' ? decision.version : '';
  const open = applyActive || !!failureText || (decision.kind === 'update' && !!upd);

  const onFailureOk = async () => {
    if (failureVersion) setDismissed((d) => [...d, failureDismissKey(failureVersion)]);
    await dismissApplyFailure();
    void refresh();
  };

  const later = () => {
    if (decision.kind !== 'update') return;
    remindLaterDeviceUpdate(decision.version);
    setDismissed((d) => [...d, decision.version]);
  };

  const skip = async () => {
    if (decision.kind !== 'update') return;
    const v = decision.version;
    skipDeviceUpdate(v);
    setDismissed((d) => [...d, v]);
    try {
      await api.updateSkip(v);
    } catch {
      toast(tr('update.saveFailed'), 'error');
    }
    void refresh();
  };

  const openRelease = () => {
    if (!upd) return;
    Linking.openURL(upd.htmlUrl).catch(() => toast(tr('update.openFailed'), 'error'));
  };

  const applyNow = () => {
    if (!upd || !status) return;
    void startApply(upd.version, status.current);
  };

  const onClose = () => {
    if (applyActive) return; // the update keeps running; the progress stays until it ends
    // closing a failure only hides it for this session; OK (onFailureOk) acknowledges it on the server
    if (failureText) {
      if (failureVersion) setDismissed((d) => [...d, failureDismissKey(failureVersion)]);
      return;
    }
    later();
  };

  const reload = () => {
    setServerChanged(false);
    try { (globalThis as any).location?.reload(); } catch {}
  };

  const banner = Platform.OS === 'web' && serverChanged && !applyActive ? (
    <View pointerEvents="box-none" style={{ position: 'absolute', left: 16, right: 16, top: 8, zIndex: 999, alignItems: 'center' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, maxWidth: 520, backgroundColor: t.panel, borderColor: t.border, borderWidth: 1, borderRadius: th.r(12), paddingHorizontal: 12, paddingVertical: 8 }}>
        <Text style={{ color: t.text, flexShrink: 1, fontSize: 14 }}>{tr('update.banner.serverChanged')}</Text>
        <Btn small primary label={tr('update.banner.reload')} onPress={reload} />
      </View>
    </View>
  ) : null;

  let title = tr('update.popup.title');
  let body: React.ReactNode = null;
  let footer: React.ReactNode = undefined;

  if (applyActive) {
    title = tr('update.pending');
    body = <ApplyProgress view={apply} />;
  } else if (failureText) {
    title = tr('update.failed.title');
    body = <ApplyFailure message={failureText} onOk={() => { void onFailureOk(); }} />;
  } else if (upd && status) {
    // native phones only link to the release page; the self-install buttons are never shown there
    const canSelf = canInstallFromHere(Platform.OS, status.selfUpdate && status.bundleAssetFound);
    const native = isNativeUpdatePlatform(Platform.OS);
    const isDocker = status.installType === 'docker';
    const notes = upd.notes || '';
    const preview = notes.length > NOTES_PREVIEW ? `${notes.slice(0, NOTES_PREVIEW)}...` : notes;
    body = (
      <View style={{ gap: 8, minWidth: 0 }}>
        <Text selectable style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>{tr('update.popup.body', { version: upd.version })}</Text>
        {!!preview && (
          <ScrollView style={{ maxHeight: 200, borderWidth: 1, borderColor: t.border, borderRadius: 8, padding: 10 }} nestedScrollEnabled>
            <Text selectable style={{ color: t.text, fontSize: 13, lineHeight: 18 }}>{preview}</Text>
          </ScrollView>
        )}
        {canSelf && <Hint>{tr('update.confirmBody')}</Hint>}
        {isDocker && !!status.dockerCommand && (
          <>
            <Hint>{tr('update.docker.hint')}</Hint>
            <CopyBlock text={status.dockerCommand} />
          </>
        )}
      </View>
    );
    footer = (
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {canSelf && <Btn primary label={tr('update.apply')} onPress={applyNow} />}
        {native && <Btn primary label={tr('update.apk.download')} onPress={openRelease} />}
        <Btn label={tr('update.skip')} onPress={() => { void skip(); }} />
        <Btn label={tr('update.popup.later')} onPress={later} />
      </View>
    );
  }

  return (
    <>
      {banner}
      <Sheet visible={open} onClose={onClose} title={title} width={460} footer={footer}>
        {body}
      </Sheet>
    </>
  );
}
