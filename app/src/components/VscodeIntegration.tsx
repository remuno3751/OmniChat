import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { api, getServerUrl, uuid } from '../api';
import { refreshModels } from '../ModelPicker';
import { activeProviders, applyUpsert, useStore } from '../store';
import { useT } from '../i18n';
import { useTheme } from '../theme';
import { setDevice, useDevice } from '../deviceSettings';
import { useBridges } from '../useBridges';
import { toast } from '../ui/toast';
import { Btn, Check, Field, Hint } from '../ui/kit';
import { CopyBlock, IntegrationCard, IntegrationStatus, Step } from './IntegrationParts';
import {
  VSCODE_EXT_VERSION, compatState, extensionOutdated, installCommand, pairingCode,
  shouldAutoAddProvider, vscodeBridges, vscodeProviderBody, vsixName,
} from '../vscodeBridge';

const wrap: any = Platform.OS === 'web' ? { overflowWrap: 'anywhere', wordBreak: 'break-word' } : null;
/** True when the URL points at this machine only (the PC running VS Code may be another one). */
const isLocalUrl = (u: string) => /^[a-z]+:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(u.trim());

/**
 * Settings > Plugins: setup card for the OmniChat VS Code extension (vscode-ext).
 * Flow: install the .vsix, generate a pairing code (a device token for this PC name), paste it into VS Code
 * (or open the vscode:// link), then watch the connection here. Connection state comes from GET /bridges (kind "vscode").
 */
export function VscodeIntegration() {
  const t = useTheme();
  const tr = useT();
  const auto = useDevice((s) => s.vscodeAutoProvider);
  const bridges = useBridges(true);
  const providersMap = useStore((s) => s.providers);
  const providers = useMemo(() => activeProviders(providersMap), [providersMap]);
  const list = useMemo(() => vscodeBridges(bridges), [bridges]);

  const [pcName, setPcName] = useState('my-pc');
  const [url, setUrl] = useState(() => getServerUrl());
  const [code, setCode] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState('');

  const name = pcName.trim() || 'my-pc';
  const serverUrl = url.trim() || getServerUrl();

  const create = async () => {
    setCreating(true);
    setErr('');
    try {
      const r = await api.createBridgeToken(name, 'vscode');
      setCode(pairingCode(serverUrl, r.token, r.name || name));
      // the provider for this PC is created right away so it is ready when the extension connects
      if (shouldAutoAddProvider(auto, providers, r.name || name)) await addProvider(r.name || name);
    } catch (e: any) {
      setErr(e?.message || tr('integ.addFailed'));
    } finally {
      setCreating(false);
    }
  };

  async function addProvider(bridgeName: string) {
    applyUpsert({ providers: [await api.putProvider(uuid(), vscodeProviderBody(bridgeName))] });
    refreshModels(true, true);
  }

  // "Add provider automatically": a paired PC (seen in /bridges) without a vscode-bridge provider gets one. Each name is tried once.
  const tried = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!auto || !bridges) return;
    for (const b of vscodeBridges(bridges)) {
      const n = b.name.trim();
      if (tried.current.has(n) || !shouldAutoAddProvider(auto, providers, n)) continue;
      tried.current.add(n);
      addProvider(n).catch((e: any) => toast(e?.message || tr('integ.addFailed'), 'error'));
    }
  }, [auto, bridges, providers]); // eslint-disable-line react-hooks/exhaustive-deps

  const online = list.filter((b) => b.online);
  const status: IntegrationStatus = bridges === null ? 'unknown' : online.length ? 'ok' : list.length ? 'warn' : 'off';
  const statusText = online.length ? tr('integ.vscode.status.connected') : list.length ? tr('integ.vscode.status.offline') : tr('integ.vscode.status.off');
  const ver = VSCODE_EXT_VERSION;

  return (
    <IntegrationCard title={tr('integ.vscode.title')} subtitle={tr('integ.vscode.subtitle')} status={status} statusText={statusText}>
      <Step n={1} title={tr('integ.vscode.step1.title')} done={list.length > 0 ? true : undefined}>
        <Hint>{tr('integ.vscode.step1.hint', { file: vsixName(ver) })}</Hint>
        <CopyBlock text={installCommand(ver)} />
      </Step>

      <Step n={2} title={tr('integ.vscode.step2.title')} done={code ? true : undefined}>
        <Hint>{tr('integ.vscode.step2.hint')}</Hint>
        {isLocalUrl(serverUrl) && <Hint danger>{tr('integ.localhostWarn')}</Hint>}
        <Field label={tr('integ.serverUrlLabel')} value={url} onChangeText={setUrl} placeholder="http://192.168.x.x:8787" />
        <Field label={tr('integ.vscode.field.name')} value={pcName} onChangeText={setPcName} placeholder="my-pc" />
        <Hint>{tr('integ.vscode.field.nameHint')}</Hint>
        <View style={{ marginTop: 8, alignSelf: 'flex-start' }}>
          <Btn small primary label={creating ? tr('integ.creating') : tr('integ.vscode.createCode')} onPress={create} disabled={creating} />
        </View>
        {!!err && <Hint danger>{err}</Hint>}
        {code !== null && (
          <View style={{ minWidth: 0 }}>
            <CopyBlock label={tr('integ.vscode.codeLabel')} text={code} />
            <Hint>{tr('integ.vscode.codeOnce')}</Hint>
          </View>
        )}
      </Step>

      <Step n={3} title={tr('integ.vscode.step3.title')} done={online.length > 0 ? true : undefined}>
        {list.length === 0 && <Hint>{tr('integ.vscode.none')}</Hint>}
        {list.map((b) => {
          const c = compatState(b);
          return (
            <View key={b.name} style={{ marginTop: 6, minWidth: 0 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: b.online ? t.good : t.border }} />
                <Text style={[{ color: t.text, fontSize: 14, fontWeight: '600', flexShrink: 1 }, wrap]}>{b.name}</Text>
                <Text style={{ color: b.online ? t.good : t.sub, fontSize: 12 }}>{tr(b.online ? 'code.device.online' : 'code.device.offline')}</Text>
              </View>
              {!!b.version && <Text style={{ color: t.sub, fontSize: 12 }}>{tr('integ.vscode.version', { version: b.version })}</Text>}
              {c === 'tooOld' && <Hint danger>{tr('integ.vscode.tooOld', { min: b.compat?.minVersion ?? ver, file: vsixName(ver) })}</Hint>}
              {c !== 'tooOld' && extensionOutdated(b) && <Hint>{tr('integ.vscode.outdated', { version: ver })}</Hint>}
              {b.busy === true && <Hint>{tr('integ.vscode.busy')}</Hint>}
            </View>
          );
        })}
      </Step>

      <Check label={tr('integ.vscode.autoProvider')} value={auto} onChange={(v) => setDevice({ vscodeAutoProvider: v })} hint={tr('integ.vscode.autoProviderHint')} />
    </IntegrationCard>
  );
}

export default VscodeIntegration;
