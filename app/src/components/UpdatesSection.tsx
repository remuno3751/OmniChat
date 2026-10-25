import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Platform, ScrollView, Text, View } from 'react-native';
import { api } from '../api';
import { APP_VERSION } from '../appVersion';
import { clientVersionLine, desktopVersionFromWindow } from '../clientVersion';
import { SOURCE_LINKS } from '../sourceLinks';
import { useT } from '../i18n';
import { setAvailableUpdateVersion, skipDeviceUpdate, unskipDeviceUpdate } from '../updateStore';
import { canApkUpdate, isPrereleaseNewerThan, updateErrorText } from '../updateState';
import { asChannel, checkResultText, desktopUpdateBridge, isPrereleaseVersion, parseCheckResult, updateActionHintKey } from '../desktopUpdate';
import type { DesktopCheckResult, DesktopUpdateBridge } from '../desktopUpdate';
import { canInstallFromHere, isNativeUpdatePlatform, UPDATE_RETRY_AFTER_ERROR_MS } from '../updateTypes';
import type { Channel, UpdateStatus } from '../updateTypes';
import { useTheme } from '../theme';
import { Btn, Field, Hint, Label, Segmented, fmtAgo } from '../ui/kit';
import { Section } from '../screens/settings/common';
import { toast } from '../ui/toast';
import { confirmDialog } from '../ui/confirm';
import { CopyBlock } from './IntegrationParts';
import { dismissApplyFailure, startApply, useApplyView } from './useApplyUpdate';
import type { ApplyView } from './useApplyUpdate';

/** Progress bar + phase label while the server updates (shared with the update popup). */
export function ApplyProgress({ view }: { view: ApplyView }) {
  const t = useTheme();
  const tr = useT();
  const p = view.progress;
  const key = view.phase === 'done'
    ? 'update.phase.done'
    : view.serverPhase === 'downloading' ? 'update.phase.downloading'
    : view.serverPhase === 'verifying' ? 'update.phase.verifying'
    : view.serverPhase === 'staging' ? 'update.phase.staging'
    : view.serverPhase === 'backing-up' ? 'update.phase.backingUp'
    : view.phase === 'restarting' || view.serverPhase === 'restarting' ? 'update.phase.restarting'
    : 'update.phase.working';
  return (
    <View style={{ gap: 6, minWidth: 0 }} accessibilityLabel={tr(key)}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {view.phase !== 'done' && <ActivityIndicator color={t.accent} />}
        <Text style={{ color: t.text, fontSize: 14, fontWeight: '600', flex: 1, minWidth: 0 }}>{tr(key)}</Text>
      </View>
      {p !== null && view.phase !== 'done' && (
        <View style={{ height: 6, borderRadius: 3, backgroundColor: t.border, overflow: 'hidden' }}>
          <View style={{ width: `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`, height: 6, backgroundColor: t.accent }} />
        </View>
      )}
      <Hint>{tr('update.keepOpen')}</Hint>
    </View>
  );
}

/** A failed or rolled-back update: the server message and an OK button (acknowledges it on the server). */
export function ApplyFailure({ message, onOk }: { message: string; onOk: () => void }) {
  const t = useTheme();
  const tr = useT();
  return (
    <View style={{ gap: 6, minWidth: 0 }}>
      <Text style={{ color: t.danger, fontSize: 14, fontWeight: '600' }}>{tr('update.failed.title')}</Text>
      <Text selectable style={{ color: t.text, fontSize: 13, lineHeight: 18 }}>{message}</Text>
      <Btn small label={tr('update.failed.ok')} onPress={onOk} />
    </View>
  );
}

/** Failure text for the Updates section and popup: an explicit server message wins over the error key. */
export function failureOf(view: ApplyView, status: UpdateStatus | null, tr: (k: string, v?: any) => string): string | null {
  if (view.phase === 'failed') return view.errorMessage ?? (view.errorKey ? tr(view.errorKey) : null);
  const a = status?.lastApply;
  if (a && a.status === 'failed' && !a.acknowledged) return a.message;
  return null;
}

/** Desktop app only: check / install a client update through the shell's bridge (window.__OMNICHAT_DESKTOP__). */
function DesktopClientUpdate({ bridge }: { bridge: DesktopUpdateBridge }) {
  const tr = useT();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<DesktopCheckResult | null>(null);
  const [channel, setChannelState] = useState<Channel | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    bridge.getUpdateChannel?.().then((c) => { if (alive) setChannelState(asChannel(c)); }, () => {});
    return () => { alive = false; };
  }, [bridge]);

  const check = async () => {
    setChecking(true);
    try {
      const r = parseCheckResult(await bridge.checkUpdate());
      setResult(r);
      setChannelState(r.channel);
    } catch {
      toast(tr('update.desktop.checkFailed'), 'error');
    } finally {
      setChecking(false);
    }
  };

  const pickChannel = async (c: Channel) => {
    if (!bridge.setUpdateChannel || c === channel) return;
    setBusy(true);
    try {
      const saved = asChannel(await bridge.setUpdateChannel(c));
      if (saved) { setChannelState(saved); setResult(null); } else toast(tr('update.saveFailed'), 'error');
    } catch {
      toast(tr('update.saveFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const text = result ? checkResultText(result) : null;
  const actionHint = result ? updateActionHintKey(result) : null;
  return (
    <View style={{ gap: 6, minWidth: 0 }}>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Btn small label={checking ? tr('update.checking') : tr('update.check')} disabled={checking} onPress={check} />
        {result?.status === 'available' && <Btn small primary label={tr('update.desktop.update')} onPress={() => { void bridge.openUpdate().catch(() => toast(tr('update.openFailed'), 'error')); }} />}
      </View>
      {text && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Hint danger={text.danger}>{tr(text.key, text.params)}</Hint>
          {result?.status === 'available' && isPrereleaseVersion(result.latest) && <Hint>{tr('update.prerelease')}</Hint>}
        </View>
      )}
      {actionHint && <Hint>{tr(actionHint)}</Hint>}
      {channel && bridge.setUpdateChannel && (
        <View style={{ gap: 6, marginTop: 4, minWidth: 0 }}>
          <Label>{tr('update.channel')}</Label>
          <Segmented<Channel>
            value={channel}
            onChange={(c) => { void pickChannel(c); }}
            options={[
              { value: 'stable', label: tr('update.channel.stable'), disabled: busy },
              { value: 'prerelease', label: tr('update.channel.prerelease'), disabled: busy },
            ]}
          />
          <Hint>{tr('update.desktop.channelHint')}</Hint>
        </View>
      )}
    </View>
  );
}

/** Settings > Updates. Non-admins see the versions and notes only. */
export default function UpdatesSection({ scope = 'all' }: { scope?: 'all' | 'server' }) {
  const serverOnly = scope === 'server';
  const t = useTheme();
  const tr = useT();
  const view = useApplyView();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  /** epoch ms of the last load attempt (re-arms the retry timer on every attempt) */
  const [loadedAt, setLoadedAt] = useState(0);
  const [checking, setChecking] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [hours, setHours] = useState('');
  const [hoursErr, setHoursErr] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await api.updateStatus();
      setStatus(s);
      setHours(String(s.checkHours));
      setLoadErr(false);
    } catch {
      setLoadErr(true);
    }
    setLoadedAt(Date.now());
  }, []);

  // load on mount, and again when an update starts / ends (the status changes then)
  useEffect(() => { void load(); }, [load, view.phase]);

  // a failed load or a server lastError: retry in 15 min (the regular 6 h poll runs in the update popup)
  const failed = loadErr || !!status?.lastError;
  useEffect(() => {
    if (!failed) return;
    const h = setTimeout(() => { void load(); }, UPDATE_RETRY_AFTER_ERROR_MS);
    return () => clearTimeout(h);
  }, [failed, loadedAt, load]);

  // keep the Settings > Updates badge in step with what this page just learned (check / skip / config)
  useEffect(() => {
    if (status) setAvailableUpdateVersion(status.updateAvailable && status.latest && !status.skipped ? status.latest.version : null);
  }, [status]);

  const admin = !!status?.isAdmin;
  const latest = status?.latest ?? null;
  // a server failure without acknowledgement is only actionable for admins (the OK button calls /update/ack)
  const failure = admin || view.phase === 'failed' ? failureOf(view, status, tr) : null;
  const applying = view.phase === 'starting' || view.phase === 'working' || view.phase === 'restarting' || view.phase === 'done';
  const isDocker = status?.installType === 'docker';
  // native phones only link to the release page (no self-install)
  const native = isNativeUpdatePlatform(Platform.OS);
  const canSelfUpdate = canInstallFromHere(Platform.OS, !!status && admin && status.selfUpdate && status.bundleAssetFound && status.updateAvailable && !!latest);

  const check = async () => {
    setChecking(true);
    try {
      setStatus(await api.updateCheck());
    } catch {
      toast(tr('update.checkFailed'), 'error');
    } finally {
      setChecking(false);
    }
  };

  /** Saves a config change and shows the returned status; errors show a toast. */
  const saveConfig = async (patch: Parameters<typeof api.updateConfig>[0], okText?: string): Promise<boolean> => {
    setBusy(true);
    try {
      setStatus(await api.updateConfig(patch));
      if (okText) toast(okText, 'ok');
      return true;
    } catch {
      toast(tr('update.saveFailed'), 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const setChannel = (c: Channel) => {
    if (status && c !== status.channel) void saveConfig({ channel: c });
  };

  const saveHours = () => {
    const v = hours.trim();
    const n = Number(v);
    if (!/^\d{1,3}$/.test(v) || n < 0 || n > 720) { setHoursErr(true); return; }
    setHoursErr(false);
    void saveConfig({ checkHours: n }, tr('update.saved'));
  };

  const saveToken = async () => {
    const ok = await saveConfig({ githubToken: token.trim() || null }, tr('update.saved'));
    if (ok) setToken(''); // never keep the value on screen
  };

  const clearToken = async () => {
    if (await saveConfig({ githubToken: null }, tr('update.token.cleared'))) setToken('');
  };

  const toggleSkip = async () => {
    if (!latest || !status) return;
    const v = latest.version;
    try {
      if (status.skipped) {
        unskipDeviceUpdate(v);
        await api.updateUnskip(v);
      } else {
        skipDeviceUpdate(v);
        await api.updateSkip(v);
      }
      await load();
    } catch {
      toast(tr('update.saveFailed'), 'error');
    }
  };

  const onApply = async () => {
    if (!latest || !status) return;
    const ok = await confirmDialog(tr('update.confirmTitle'), tr('update.confirmBody'), tr('update.apply'), false);
    if (ok) void startApply(latest.version, status.current);
  };

  const openApk = () => {
    if (!latest) return;
    Linking.openURL(latest.htmlUrl).catch(() => toast(tr('update.openFailed'), 'error'));
  };

  const desktopBridge = Platform.OS === 'web' ? desktopUpdateBridge(globalThis as any) : null;
  const androidApk = Platform.OS === 'android' && !!latest && canApkUpdate(latest.version, APP_VERSION);

  return (
    <>
      {!serverOnly && (<>
      <Section title={tr('update.appSection')} first />
      <View style={{ gap: 6, minWidth: 0 }}>
        <Text selectable style={{ color: t.text, fontSize: 14 }}>{(() => { const c = clientVersionLine(Platform.OS, APP_VERSION, desktopVersionFromWindow(globalThis as any)); return tr(c.key, { version: c.version }); })()}</Text>
<Hint>{tr(Platform.OS === 'android' ? 'update.appHint.android' : Platform.OS === 'web' ? (desktopBridge ? 'update.appHint.desktop' : 'update.appHint.web') : 'update.appHint.desktop')}</Hint>
        {desktopBridge && <DesktopClientUpdate bridge={desktopBridge} />}
        {androidApk && latest && (
          <View style={{ gap: 6 }}>
            <Hint>{tr('update.apk.available', { version: latest.version })}</Hint>
            <Hint>{tr('update.apk.hint')}</Hint>
            <Btn small label={tr('update.apk.download')} onPress={openApk} />
          </View>
        )}
      </View>

      </>)}

      {!serverOnly && <Section title={tr('update.serverSection')} />}
      {loadErr && <Hint danger>{tr('update.loadFailed')}</Hint>}
      {status && (
        <View style={{ gap: 6, minWidth: 0 }}>
          <Text selectable style={{ color: t.text, fontSize: 14 }}>{tr('update.version', { version: status.current })}</Text>
          <Hint>{tr('update.installType', { type: tr(`update.install.${status.installType}`) })}</Hint>
          <Hint>{status.lastCheckedAt ? tr('update.lastChecked', { when: fmtAgo(status.lastCheckedAt) }) : tr('update.neverChecked')}</Hint>
          {status.lastError && <Hint danger>{tr(updateErrorText(status.lastError).key, updateErrorText(status.lastError).params)}</Hint>}
        </View>
      )}

      {failed && (
        <Btn small label={tr('update.retry')} disabled={checking || applying} onPress={() => { if (admin) void check(); else void load(); }} />
      )}

      {admin && (
        <Btn label={checking ? tr('update.checking') : tr('update.check')} disabled={checking || applying} onPress={check} />
      )}
      {!status && !loadErr && <ActivityIndicator color={t.accent} />}

      {latest ? (
        <View style={{ gap: 6, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Text selectable style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>{tr('update.latest', { version: latest.version })}</Text>
            {latest.prerelease && (
              <Text style={{ color: t.accentText, backgroundColor: t.accent, fontSize: 11, fontWeight: '700', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden' }}>{tr('update.prerelease')}</Text>
            )}
          </View>
          {status && !status.updateAvailable && (isPrereleaseNewerThan(status.current, latest.version)
            ? <Hint>{tr('update.prereleaseInUse', { version: latest.version })}</Hint>
            : <Hint>{tr('update.upToDate')}</Hint>)}
          {status && status.updateAvailable && status.skipped && <Hint>{tr('update.skipped')}</Hint>}

          <Btn small label={notesOpen ? tr('update.notes.hide') : tr('update.notes.show')} onPress={() => setNotesOpen((o) => !o)} />
          {native && !androidApk && status?.updateAvailable && <Btn small label={tr('update.apk.download')} onPress={openApk} />}
          {notesOpen && (
            <ScrollView style={{ maxHeight: 220, borderWidth: 1, borderColor: t.border, borderRadius: 8, padding: 10 }} nestedScrollEnabled>
              <Text selectable style={{ color: t.text, fontSize: 13, lineHeight: 18 }}>{latest.notes || tr('update.notes.empty')}</Text>
            </ScrollView>
          )}

          {admin && status?.updateAvailable && !applying && (
            <View style={{ gap: 6 }}>
              {canSelfUpdate && <Btn primary label={tr('update.apply')} onPress={onApply} />}
              {isDocker && status.dockerCommand && (
                <>
                  <Hint>{tr('update.docker.hint')}</Hint>
                  <CopyBlock text={status.dockerCommand} />
                </>
              )}
              {!native && !canSelfUpdate && !isDocker && !!status.selfUpdateReason && <Hint>{tr('update.selfUpdateOff', { reason: status.selfUpdateReason })}</Hint>}
              {!native && !canSelfUpdate && !isDocker && !status.selfUpdateReason && status.selfUpdate && !status.bundleAssetFound && <Hint>{tr('update.noBundle')}</Hint>}
              <Btn small label={status.skipped ? tr('update.unskip') : tr('update.skip')} onPress={toggleSkip} />
            </View>
          )}
        </View>
      ) : (
        status && <Hint>{tr('update.noRelease')}</Hint>
      )}

      {applying && <ApplyProgress view={view} />}
      {!applying && failure && (
        <ApplyFailure message={failure} onOk={() => { void dismissApplyFailure().then(load); }} />
      )}

      {admin && status && (
        <View style={{ gap: 6, marginTop: 8, minWidth: 0 }}>
          <Label>{tr('update.channel')}</Label>
          <Segmented<Channel>
            value={status.channel}
            onChange={setChannel}
            options={[
              { value: 'stable', label: tr('update.channel.stable'), disabled: busy },
              { value: 'prerelease', label: tr('update.channel.prerelease'), disabled: busy },
            ]}
          />
          <Hint>{tr('update.channel.hint')}</Hint>

          <Field
            label={tr('update.checkHours')}
            value={hours}
            onChangeText={(v) => { setHours(v); setHoursErr(false); }}
            keyboardType="number-pad"
            placeholder="12"
            onSubmit={saveHours}
          />
          {hoursErr && <Hint danger>{tr('update.checkHours.invalid')}</Hint>}
          <Hint>{tr('update.checkHours.hint')}</Hint>
          <Btn small label={tr('common.save')} disabled={busy} onPress={saveHours} />

          <Field
            label={tr('update.token.label')}
            value={token}
            onChangeText={setToken}
            secure
            placeholder={status.tokenSet ? '••••••••' : ''}
            onSubmit={saveToken}
          />
          <Hint>{status.tokenSet ? tr('update.token.saved') : tr('update.token.notSet')}</Hint>
          <Hint>{tr('update.token.hint')}</Hint>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Btn small label={tr('common.save')} disabled={busy || !token.trim()} onPress={saveToken} />
            {status.tokenSet && <Btn small danger label={tr('update.token.clear')} disabled={busy} onPress={clearToken} />}
          </View>
        </View>
      )}
      {!admin && status && <Hint>{tr('update.readOnly')}</Hint>}

      {!serverOnly && (<>
      <Section title={tr('update.sourceSection')} />
      <Hint>{tr('update.sourceHint')}</Hint>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Btn small label={tr('update.src.repo')} onPress={() => { Linking.openURL(SOURCE_LINKS.repo).catch(() => toast(tr('update.openFailed'), 'error')); }} />
        <Btn small label={tr('update.src.releases')} onPress={() => { Linking.openURL(SOURCE_LINKS.releases).catch(() => toast(tr('update.openFailed'), 'error')); }} />
        <Btn small label={tr('update.src.license')} onPress={() => { Linking.openURL(SOURCE_LINKS.license).catch(() => toast(tr('update.openFailed'), 'error')); }} />
        <Btn small label={tr('update.src.issues')} onPress={() => { Linking.openURL(SOURCE_LINKS.issues).catch(() => toast(tr('update.openFailed'), 'error')); }} />
      </View>
      </>)}
    </>
  );
}
