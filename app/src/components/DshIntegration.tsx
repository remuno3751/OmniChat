import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Platform, Pressable, Text, View } from 'react-native';
import { api, ApiError, getServerUrl, uuid } from '../api';
import { refreshModels } from '../ModelPicker';
import { activeProviders, applyUpsert, useStore } from '../store';
import { useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';
import { Btn, Field, Hint } from '../ui/kit';
import { setDevice, useDevice, type DshSettings } from '../deviceSettings';
import {
  cancelDshPairRequest,
  connectDshRelay,
  isRelaySupported,
  retryDshRelay,
  startDshPairRequest,
  useDshPairRequestStatus,
  useDshRelayStatus,
} from '../dshRelayClient';
import { takePendingDshPair } from '../dshPairLink';
import type { LocalState } from '../dshRelay';
import type { PairRequestError } from '../dshPairRequest';
import Icon from './Icon';
import { CopyBlock, IntegrationCard, IntegrationStatus, Step } from './IntegrationParts';
import PluginUpdateRow from './PluginUpdateRow';

const DSH_PROVIDER_NAME = 'DeepSeek Harness (PC bridge)';
const DSH_KIND = 'dsh-bridge';
const DSH_MODEL = 'dsh';
const POLL_MS = 10000;
const RELEASES_URL = 'https://github.com/remuno3751/OmniChat/releases/latest';
const TGZ = 'omnichat-dsh-bridge-1.0.2.tgz';

/** Name shown to the user in DSH when this app asks for approval. Not translated (it is a host name). */
function pairClientName(): string {
  try {
    const host = typeof location !== 'undefined' ? location.host : '';
    return host ? `OmniChat (${host})` : 'OmniChat (web)';
  } catch {
    return 'OmniChat (web)';
  }
}

/** True when the URL points at this machine only (other PCs cannot reach it). */
const isLocalUrl = (u: string) => /^[a-z]+:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(u.trim());

/** 1-65535 as a string of digits, or null. */
function parsePort(s: string): number | null {
  const v = s.trim();
  if (!/^\d{1,5}$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= 65535 ? n : null;
}

/** Long unbroken strings (codes, URLs, paths) wrap on web instead of overflowing 375 px screens. */
const wrap: any = Platform.OS === 'web' ? { overflowWrap: 'anywhere', wordBreak: 'break-word' } : null;

/** Expandable row used for the Advanced, Remote mode and Troubleshooting sections. */
function Toggle({ label, open, onPress }: { label: string; open: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      {...({ 'aria-expanded': open } as any)}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4, minWidth: 0 }}
    >
      <Text style={[{ flex: 1, minWidth: 0, color: t.text, fontSize: 14, fontWeight: '600' }, wrap]}>{label}</Text>
      <Icon name={open ? 'collapse' : 'expand'} size={18} color={t.sub} />
    </Pressable>
  );
}

function Bullets({ items }: { items: string[] }) {
  const t = useTheme();
  return (
    <View style={{ gap: 6, minWidth: 0 }}>
      {items.map((line, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 8, minWidth: 0 }}>
          <Text style={{ color: t.sub, fontSize: 13 }}>•</Text>
          <Text style={[{ flex: 1, minWidth: 0, color: t.text, fontSize: 13, lineHeight: 18 }, wrap]}>{line}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * Settings > Plugins: setup card for the DeepSeek Harness plugin (dsh-plugin).
 * The default flow is the local relay (this app relays between the PC plugin on 127.0.0.1 and the
 * OmniChat server). The token flow for headless PCs sits in a collapsed "remote mode" section.
 * Polls GET /bridges every 10 s (stops on 404 = server too old) to show online bridges.
 */
export function DshIntegration() {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const providers = activeProviders(useStore((s) => s.providers));
  const dsh = useDevice((s) => s.dsh);
  const relay = useDshRelayStatus();
  const supported = isRelaySupported();

  const [bridges, setBridges] = useState<{ name: string; cwd?: string; online: boolean }[] | null>(null);
  const [err, setErr] = useState<'old' | 'failed' | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [pairing, setPairing] = useState(dsh.pairing);
  const [bridgeName, setBridgeName] = useState(dsh.bridgeName);
  const [portText, setPortText] = useState(String(dsh.port));
  const [advanced, setAdvanced] = useState(false);
  const [connectErr, setConnectErr] = useState('');
  const [providerErr, setProviderErr] = useState('');
  const [trouble, setTrouble] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const pairState = useDshPairRequestStatus();
  const [clock, setClock] = useState(() => Date.now());

  const [remoteOpen, setRemoteOpen] = useState(false);
  const [cmdUrl, setCmdUrl] = useState(() => getServerUrl());
  const [pcName, setPcName] = useState('my-pc');
  const [token, setToken] = useState<string | null>(null);
  const [tokenErr, setTokenErr] = useState('');
  const [creating, setCreating] = useState(false);

  // Keep the inputs in step with the stored settings (they load asynchronously).
  useEffect(() => { setPairing(dsh.pairing); }, [dsh.pairing]);
  useEffect(() => { setBridgeName(dsh.bridgeName); }, [dsh.bridgeName]);
  useEffect(() => { setPortText(String(dsh.port)); }, [dsh.port]);

  // Poll the bridge list. A 404 means the server predates /bridges: stop polling.
  useEffect(() => {
    if (!supported) return;
    let alive = true;
    let timer: any = null;
    const tick = async () => {
      try {
        const r = await api.bridges();
        if (!alive) return;
        // VS Code extension bridges have their own card
        setBridges(Array.isArray(r?.bridges) ? r.bridges.filter((b) => (b.kind ?? 'dsh') === 'dsh') : []);
        setErr(null);
      } catch (e: any) {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 404) { setErr('old'); return; }
        setErr('failed');
      }
      if (alive) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [refreshKey, supported]);

  const online = useMemo(() => (bridges || []).filter((b) => b.online), [bridges]);
  const onlineNames = useMemo(() => new Set(online.map((b) => b.name.trim())), [online]);

  /** Saves the pairing settings and starts (or restarts) the relay with them. */
  const applyPairing = (patch: Partial<DshSettings>) => {
    if (relay !== null) {
      // A relay is already running: the settings change restarts it, retry forces a fresh connection.
      setDevice({ dsh: patch });
      retryDshRelay();
    } else {
      // First start: mark it as a first pairing before the relay is created.
      connectDshRelay();
      setDevice({ dsh: patch });
    }
  };

  /** Manual path: pairs with `codeOverride` (a deep-link code) or with the input value. */
  const connect = (codeOverride?: string) => {
    const code = (codeOverride ?? pairing).trim();
    const port = parsePort(portText);
    if (!code) { setConnectErr(tr('integ.dsh2.err.pairingEmpty')); return; }
    if (port === null) { setConnectErr(tr('integ.dsh2.err.port')); return; }
    setConnectErr('');
    cancelDshPairRequest();
    applyPairing({ enabled: true, port, pairing: code, bridgeName: bridgeName.trim() || 'my-pc' });
  };

  /** Default path: asks DSH to approve this app; the token arrives only after the user allows it. */
  const approve = () => {
    const port = parsePort(portText);
    if (port === null) { setConnectErr(tr('integ.dsh2.err.port')); return; }
    setConnectErr('');
    startDshPairRequest({
      port,
      clientName: pairClientName(),
      onApproved: (token) => applyPairing({ enabled: true, port, pairing: token, bridgeName: bridgeName.trim() || 'my-pc' }),
    });
  };

  // Pairing link (#dsh-pair=...): take the code once, prefill the input and submit. The ref guards
  // against a second run under StrictMode; the code itself is taken from the module, never logged.
  const pairLinkDone = useRef(false);
  const [pairLinkNotice, setPairLinkNotice] = useState(false);
  useEffect(() => {
    if (!supported || pairLinkDone.current) return;
    pairLinkDone.current = true;
    const code = takePendingDshPair();
    if (!code) return;
    setPairing(code);
    setManualOpen(true);
    setPairLinkNotice(true);
    connect(code);
  }, [supported]);

  // Keep the approval request in step with the screen: tick the countdown while pending,
  // open the manual code when DSH refuses the origin, and cancel the request on unmount.
  useEffect(() => {
    if (pairState.state !== 'pending') return;
    setClock(Date.now());
    const h: any = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(h);
  }, [pairState.state]);

  useEffect(() => {
    if (pairState.error === 'origin') setManualOpen(true);
  }, [pairState.error]);

  useEffect(() => () => cancelDshPairRequest(), []);

  const pairBusy = pairState.state === 'connecting' || pairState.state === 'pending';
  const secondsLeft = pairState.expiresAt ? Math.max(0, Math.ceil((pairState.expiresAt - clock) / 1000)) : 0;
  const pairMsg =
    pairState.state === 'denied'
      ? tr('integ.dsh2.pair.denied')
      : pairState.state === 'expired'
        ? tr('integ.dsh2.pair.expired')
        : pairState.state === 'error'
          ? pairErrorText(pairState.error)
          : null;

  function pairErrorText(e?: PairRequestError): string {
    switch (e) {
      case 'origin': return tr('integ.dsh2.pair.errOrigin');
      case 'locked': return tr('integ.dsh2.pair.errLocked');
      case 'busy': return tr('integ.dsh2.pair.errBusy');
      case 'unreachable': return tr('integ.dsh2.pair.errUnreachable');
      case 'invalid': return tr('integ.dsh2.pair.errInvalid');
      default: return tr('integ.dsh2.pair.errUnknown');
    }
  }

  if (!supported) {
    return (
      <IntegrationCard title={tr('integ.dsh2.title')} subtitle={tr('integ.dsh2.subtitle')} status="off" statusText={tr('integ.dsh2.pcOnly')}>
        <Hint>{tr('integ.dsh2.pcOnly')}</Hint>
      </IntegrationCard>
    );
  }

  const anyOnline = online.length > 0;
  const dshProviders = providers.filter((p) => p.kind === DSH_KIND);
  const providerExists = dshProviders.length > 0;
  const mismatch = bridges === null ? [] : dshProviders.filter((p) => !onlineNames.has((p.baseUrl ?? '').trim()));

  const enabled = dsh.enabled;
  const local: LocalState = relay?.local ?? 'off';
  const server = relay?.server ?? 'off';
  const fullyConnected = local === 'connected' && server === 'connected';
  const pluginReachable = local === 'connected' || local === 'auth-failed' || local === 'replaced';

  const status: IntegrationStatus = !enabled ? 'off' : fullyConnected ? 'ok' : 'warn';
  const statusText = !enabled
    ? tr('integ.dsh2.status.off')
    : fullyConnected
      ? tr('integ.dsh2.status.connected')
      : local === 'auth-failed'
        ? tr('integ.dsh2.status.pairingRejected')
        : local === 'replaced'
          ? tr('integ.dsh2.status.replaced')
          : tr('integ.dsh2.status.connecting');

  const localRow = local === 'connected'
    ? { text: tr('integ.dsh2.state.connected'), color: t.good }
    : local === 'auth-failed'
      ? { text: tr('integ.dsh2.state.pairingRejected'), color: t.warn }
      : local === 'replaced'
        ? { text: tr('integ.dsh2.state.replaced'), color: t.warn }
        : { text: tr('integ.dsh2.state.connecting'), color: t.sub };
  const serverRow = server === 'connected'
    ? { text: tr('integ.dsh2.state.connected'), color: t.good }
    : server === 'connecting'
      ? { text: tr('integ.dsh2.state.connecting'), color: t.sub }
      : { text: tr('integ.dsh2.state.waiting'), color: t.sub };

  const lastErr = relay?.lastError
    ? relay.lastError === 'origin not allowed'
      ? tr('integ.dsh2.err.origin')
      : relay.lastError === 'locked, retrying later'
        ? tr('integ.dsh2.err.locked')
        : tr('integ.dsh2.lastError', { error: relay.lastError })
    : null;

  const disconnect = () => {
    setConnectErr('');
    setDevice({ dsh: { enabled: false } });
  };

  const name = pcName.trim() || 'my-pc';
  const url = cmdUrl.trim() || getServerUrl();

  const createToken = async () => {
    setCreating(true);
    setTokenErr('');
    try {
      const r = await api.createBridgeToken(name);
      setToken(r.token);
    } catch (e: any) {
      setTokenErr(e?.message || tr('integ.addFailed'));
    } finally {
      setCreating(false);
    }
  };

  const addProvider = async () => {
    try {
      const baseUrl = online[0]?.name || dsh.bridgeName || name;
      applyUpsert({ providers: [await api.putProvider(uuid(), { name: DSH_PROVIDER_NAME, kind: DSH_KIND, baseUrl, model: DSH_MODEL })] });
      refreshModels(true, true);
      setProviderErr('');
    } catch (e: any) {
      setProviderErr(e?.message || tr('integ.addFailed'));
    }
  };

  const setx = [
    `setx OMNICHAT_SERVER_URL "${url}"`,
    `setx OMNICHAT_TOKEN "${token ?? ''}"`,
    `setx OMNICHAT_NAME "${name}"`,
    'setx OMNICHAT_MODE "remote"',
  ].join('\n');
  const yaml = [
    '- id: omnichat-bridge',
    '  config:',
    `    serverUrl: ${url}`,
    `    token: ${token ?? ''}`,
    `    name: ${name}`,
    '    mode: remote',
    '    mirror: true',
    '    approvals: remote',
  ].join('\n');

  const tokenCreated = token !== null;

  const liveRow = (label: string, text: string, color: string) => (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, minWidth: 0 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, marginTop: 5, backgroundColor: color }} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[{ color: t.text, fontSize: 13, fontWeight: '600' }, wrap]}>{label}</Text>
        <Text style={[{ color, fontSize: 13 }, wrap]}>{text}</Text>
      </View>
    </View>
  );

  return (
    <IntegrationCard title={tr('integ.dsh2.title')} subtitle={tr('integ.dsh2.subtitle')} status={status} statusText={statusText}>
      {pairLinkNotice && <Hint>{tr('integ.dsh2.autoPair')}</Hint>}
      {err === 'old' && <Hint danger>{tr('integ.serverTooOld')}</Hint>}
      {err === 'failed' && <Hint danger>{tr('integ.status.checkFailed')}</Hint>}
      <PluginUpdateRow />

      {enabled && (
        <View style={{ marginTop: 8, gap: 8, minWidth: 0, borderWidth: 1, borderColor: t.border, borderRadius: th.r(8), padding: 10 }}>
          <Text style={{ color: t.sub, fontSize: 12, fontWeight: '600' }}>{tr('integ.dsh2.live.title')}</Text>
          {liveRow(tr('integ.dsh2.live.local'), localRow.text, localRow.color)}
          {liveRow(tr('integ.dsh2.live.server'), serverRow.text, serverRow.color)}
          <Text style={[{ color: t.sub, fontSize: 12 }, wrap]}>{tr('integ.dsh2.bridge', { name: relay?.bridgeName ?? bridgeName })}</Text>
          {relay && (
            <Text style={{ color: t.sub, fontSize: 12 }}>
              {tr('integ.dsh2.frames', { up: relay.framesToServer, down: relay.framesToLocal })}
            </Text>
          )}
          {!!lastErr && <Text style={[{ color: t.danger, fontSize: 12 }, wrap]}>{lastErr}</Text>}
          {(local === 'auth-failed' || local === 'replaced') && (
            <View style={{ alignSelf: 'flex-start' }}>
              <Btn small label={tr('integ.dsh2.retry')} onPress={() => retryDshRelay()} />
            </View>
          )}
        </View>
      )}

      <View style={{ marginTop: 12, minWidth: 0 }}>
        {!!online.length && (
          <View style={{ gap: 4 }}>
            <Text style={{ color: t.sub, fontSize: 12 }}>{tr('integ.onlineBridges')}</Text>
            {online.map((b) => (
              <View key={b.name} style={{ minWidth: 0 }}>
                <Text style={{ color: t.text, fontSize: 14, fontWeight: '600' }}>{b.name}</Text>
                {!!b.cwd && <Text style={[{ color: t.sub, fontSize: 12 }, wrap]}>{tr('integ.bridgeCwd', { cwd: b.cwd })}</Text>}
              </View>
            ))}
          </View>
        )}
        <View style={{ alignSelf: 'flex-start', marginTop: 8 }}>
          <Btn small label={tr('common.refresh')} onPress={() => setRefreshKey((k) => k + 1)} />
        </View>
      </View>

      <Step n={1} title={tr('integ.dsh2.step1.title')} done={pluginReachable ? true : undefined}>
        <Hint>{tr('integ.dsh2.step1.hint')}</Hint>
        <Hint>{`→ ${TGZ}`}</Hint>
        <View style={{ alignSelf: 'flex-start' }}>
          <Btn small primary label={tr('integ.dsh2.step1.download')} onPress={() => { Linking.openURL(RELEASES_URL).catch(() => {}); }} />
        </View>
        <Hint>{tr('integ.dsh2.step1.install')}</Hint>
        <CopyBlock
          label="desktop / web (Command Prompt)"
          text={`dsh plugin --profile desktop add "%USERPROFILE%\\Downloads\\${TGZ}"\ndsh plugin --profile web add "%USERPROFILE%\\Downloads\\${TGZ}"`}
        />
        <Hint>{tr('integ.dsh2.step1.closeGui')}</Hint>
        <Hint>{tr('integ.dsh2.step1.noEnv')}</Hint>
      </Step>

      <Step n={2} title={tr('integ.dsh2.step2.title')} done={local === 'connected' ? true : undefined}>
        <Hint>{tr('integ.dsh2.step2.hint')}</Hint>
        <Hint>{tr('integ.dsh2.step2.note')}</Hint>
      </Step>

      <Step n={3} title={tr('integ.dsh2.step3.title')} done={fullyConnected ? true : undefined}>
        <View style={{ minWidth: 0 }}>
          <Field label={tr('integ.dsh2.field.bridgeName')} value={bridgeName} onChangeText={setBridgeName} placeholder="my-pc" />
          <Hint>{tr('integ.dsh2.field.bridgeNameHint')}</Hint>
        </View>
        <View style={{ marginTop: 8, minWidth: 0 }}>
          <Toggle label={tr('integ.dsh2.advanced')} open={advanced} onPress={() => setAdvanced((v) => !v)} />
          {advanced && (
            <View style={{ minWidth: 0 }}>
              <Field label={tr('integ.dsh2.field.port')} value={portText} onChangeText={setPortText} placeholder="19401" keyboardType="number-pad" />
              <Hint>{tr('integ.dsh2.field.portHint')}</Hint>
            </View>
          )}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          <Btn small primary label={tr('integ.dsh2.connectApprove')} onPress={approve} disabled={pairBusy} />
          {enabled && <Btn small label={tr('integ.dsh2.disconnect')} onPress={disconnect} />}
        </View>
        {pairState.state === 'connecting' && <Hint>{tr('integ.dsh2.pair.connecting')}</Hint>}
        {pairState.state === 'pending' && (
          <View style={{ marginTop: 8, padding: 10, gap: 8, minWidth: 0, borderWidth: 1, borderColor: t.accent, borderRadius: 8 }}>
            <Text style={[{ color: t.text, fontSize: 14, fontWeight: '600' }, wrap]}>{tr('integ.dsh2.waitApproval')}</Text>
            <Text style={{ color: t.sub, fontSize: 12 }}>{tr('integ.dsh2.waitCountdown', { seconds: secondsLeft })}</Text>
            <View style={{ alignSelf: 'flex-start' }}>
              <Btn small label={tr('common.cancel')} onPress={() => cancelDshPairRequest()} />
            </View>
          </View>
        )}
        {!!pairMsg && <Hint danger>{pairMsg}</Hint>}
        {!!connectErr && <Hint danger>{connectErr}</Hint>}
        <Hint>{tr('integ.dsh2.step3.hint')}</Hint>
        <View style={{ marginTop: 8, minWidth: 0 }}>
          <Toggle label={tr('integ.dsh2.manual')} open={manualOpen} onPress={() => setManualOpen((v) => !v)} />
          {manualOpen && (
            <View style={{ gap: 8, marginTop: 4, minWidth: 0 }}>
              <Hint>{tr('integ.dsh2.manual.hint')}</Hint>
              <CopyBlock text="node dist/pair.js" />
              <Field label={tr('integ.dsh2.field.pairing')} value={pairing} onChangeText={setPairing} />
              <View style={{ alignSelf: 'flex-start' }}>
                <Btn small primary label={tr('integ.dsh2.connect')} onPress={() => connect()} />
              </View>
            </View>
          )}
        </View>
      </Step>

      <Step n={4} title={tr('integ.dsh2.step4.title')} done={providerExists}>
        <Hint>{tr('integ.dsh2.step4.hint')}</Hint>
        {!providerExists && (
          <View style={{ marginTop: 8, alignSelf: 'flex-start' }}>
            <Btn small primary label={tr('integ.dsh2.step4.add')} onPress={addProvider} />
          </View>
        )}
        {providerExists && <Hint>{tr('integ.dsh2.step4.added')}</Hint>}
        {!!providerErr && <Hint danger>{providerErr}</Hint>}
        {mismatch.map((p) => (
          <Hint key={p.id} danger>{tr('integ.dsh2.step4.mismatch', { url: p.baseUrl ?? '' })}</Hint>
        ))}
      </Step>

      <Step n={5} title={tr('integ.dsh2.step5.title')} done={anyOnline && providerExists ? true : undefined}>
        <Hint>{tr('integ.dsh2.step5.hint')}</Hint>
      </Step>

      <View style={{ marginTop: 16, minWidth: 0 }}>
        <Toggle label={tr('integ.dsh2.remote.title')} open={remoteOpen} onPress={() => setRemoteOpen((v) => !v)} />
        {remoteOpen && (
          <View style={{ gap: 6, marginTop: 4, minWidth: 0 }}>
            <Hint>{tr('integ.dsh2.remote.hint')}</Hint>
            {isLocalUrl(getServerUrl()) && <Hint danger>{tr('integ.localhostWarn')}</Hint>}

            <View style={{ marginTop: 6 }}>
              <Field label={tr('integ.serverUrlLabel')} value={cmdUrl} onChangeText={setCmdUrl} placeholder="http://192.168.x.x:8787" />
              <Hint>{tr('integ.serverUrlHint')}</Hint>
            </View>

            <Text style={{ color: t.text, fontSize: 14, fontWeight: '600', marginTop: 8 }}>{tr('integ.step4.title')}</Text>
            <Field label={tr('integ.step4.nameLabel')} value={pcName} onChangeText={setPcName} placeholder="my-pc" />
            <Hint>{tr('integ.dsh2.remote.nameHint')}</Hint>
            <View style={{ marginTop: 8, alignSelf: 'flex-start' }}>
              <Btn
                small
                label={creating ? tr('integ.creating') : tr('integ.step4.createToken')}
                onPress={createToken}
                disabled={creating}
                primary
              />
            </View>
            {!!tokenErr && <Hint danger>{tokenErr}</Hint>}
            {tokenCreated && (
              <View style={{ minWidth: 0 }}>
                <CopyBlock label={tr('integ.step4.tokenLabel')} text={token!} />
                <Hint>{tr('integ.step4.tokenOnce')}</Hint>
                <CopyBlock text={setx} />
                <Hint>{tr('integ.step4.setxNote')}</Hint>
                <View style={{ marginTop: 10, minWidth: 0 }}>
                  <Text style={{ color: t.sub, fontSize: 12, fontWeight: '600' }}>{tr('integ.step4.yamlTitle')}</Text>
                  <CopyBlock text={yaml} />
                  <Hint danger>{tr('integ.step4.yamlWarn')}</Hint>
                </View>
              </View>
            )}
          </View>
        )}
      </View>

      <View style={{ marginTop: 16, minWidth: 0 }}>
        <Toggle label={tr('integ.trouble.title')} open={trouble} onPress={() => setTrouble((v) => !v)} />
        {trouble && (
          <View style={{ gap: 6, marginTop: 4, minWidth: 0 }}>
            <Text style={{ color: t.sub, fontSize: 12 }}>{tr('integ.dsh2.trouble.head')}</Text>
            <Bullets
              items={[
                tr('integ.dsh2.trouble.pairing'),
                tr('integ.dsh2.trouble.origin'),
                tr('integ.dsh2.trouble.replaced'),
                tr('integ.dsh2.trouble.mixed'),
                tr('integ.dsh2.trouble.notRunning'),
                tr('integ.dsh2.trouble.runsWhileOpen'),
                tr('integ.dsh2.trouble.security'),
              ]}
            />
            <Text style={{ color: t.sub, fontSize: 12, marginTop: 4 }}>{tr('integ.trouble.doctor')}</Text>
            <CopyBlock text="omnichat doctor" />
          </View>
        )}
      </View>
    </IntegrationCard>
  );
}

export default DshIntegration;
