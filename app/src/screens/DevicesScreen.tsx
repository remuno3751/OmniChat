import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ApiError, api } from '../api';
import { deviceOf } from '../codeGroups';
import { useT } from '../i18n';
import { addHiddenDevice, bridgeNameOfDevice, groupDevicesByName, parseHiddenDevices, staleDevices } from '../deviceList';
import type { Device } from '../protocol';
import { useStore } from '../store';
import { useTheme, useThemeDef } from '../theme';
import { confirmDialog } from '../ui/confirm';
import { Btn, Hint, ScreenHeader, Sheet, fmtAgo } from '../ui/kit';
import { toast } from '../ui/toast';

/** Locally hidden device names (the list only; no server API for this). */
export const HIDDEN_DEVICES_KEY = 'omnichat.hiddenDevices.v1';

/** Settings > Devices: every signed-in device with last-seen and Revoke. Same-named devices are grouped (x N). */
export default function DevicesScreen({ onBack, onLoggedOut }: { onBack: () => void; onLoggedOut: () => void }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const conversations = useStore((s) => s.conversations);
  const providers = useStore((s) => s.providers);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [err, setErr] = useState('');
  const [hidden, setHidden] = useState<string[]>([]);
  /** a revoke that would leave conversations on a device: waits for the keep / hide choice */
  const [choice, setChoice] = useState<{ list: Device[]; names: string[]; convs: number } | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(HIDDEN_DEVICES_KEY).then((raw) => setHidden(parseHiddenDevices(raw)), () => {});
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await api.devices();
      setDevices([...(r.devices || [])]);
      setErr('');
    } catch (e: any) {
      setErr(e instanceof ApiError && e.status === 404 ? tr('devices.unsupported') : e.message || String(e));
      setDevices([]);
    }
  }, [tr]);
  useEffect(() => { load(); }, [load]);

  const visible = useMemo(
    () => groupDevicesByName((devices ?? []).filter((d) => d.current || !hidden.includes(d.name))),
    [devices, hidden],
  );
  const stale = useMemo(() => staleDevices(devices ?? [], Date.now()), [devices]);

  /** Conversations whose bridge is this device (matched by the bridge name inside the device name). */
  const convCountFor = (name: string): number => {
    const bridge = bridgeNameOfDevice(name);
    if (!bridge) return 0;
    return Object.values(conversations).filter((c) => deviceOf(c, providers) === bridge).length;
  };

  const finishRevoke = async (list: Device[], hide: boolean) => {
    let failed = 0;
    let loggedOut = false;
    const done: string[] = [];
    for (const d of list) {
      try {
        await api.revokeDevice(d.id);
        if (d.current) loggedOut = true;
        else done.push(d.name);
      } catch {
        failed++;
      }
    }
    if (hide && done.length) {
      let next = hidden;
      for (const n of done) next = addHiddenDevice(next, n);
      setHidden(next);
      AsyncStorage.setItem(HIDDEN_DEVICES_KEY, JSON.stringify(next)).catch(() => {});
    }
    if (loggedOut) { onLoggedOut(); return; }
    if (failed) toast(tr('devices.revokeSomeFailed', { n: failed }), 'error');
    else toast(tr('devices.revoked'), 'ok');
    load();
  };

  /** Revokes the devices, asking first when some of them still have conversations (keep or hide). */
  const revokeMany = (list: Device[]) => {
    const others = list.filter((d) => !d.current);
    const names = [...new Set(others.map((d) => d.name))];
    const convs = names.reduce((n, name) => n + convCountFor(name), 0);
    if (convs > 0) { setChoice({ list, names, convs }); return; }
    void finishRevoke(list, false);
  };

  const revoke = async (d: Device) => {
    const ok = await confirmDialog(
      d.current ? tr('devices.revokeThisTitle') : tr('devices.revokeTitle'),
      d.current ? tr('devices.revokeThisMsg') : tr('devices.revokeMsg', { name: d.name }),
      tr('tools.revoke'),
    );
    if (!ok) return;
    revokeMany([d]);
  };

  const revokeStale = async () => {
    const ok = await confirmDialog(
      tr('devices.revokeStale'),
      tr('devices.staleConfirm', { n: stale.length }),
      tr('tools.revoke'),
    );
    if (!ok) return;
    revokeMany(stale);
  };

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <ScreenHeader title={tr('settings.devices')} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.body}>
        <Hint>{tr('devices.hint')}</Hint>
        {devices === null && <ActivityIndicator color={t.accentInk} style={{ margin: 20 }} />}
        {!!err && <Hint danger>{err}</Hint>}
        {visible.map((g) => {
          const d = g.primary;
          return (
            <View key={d.id} style={[styles.card, { borderRadius: th.r(12) }, { borderColor: t.border, backgroundColor: t.panel }]}>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Text style={{ color: t.text, fontWeight: '600', fontSize: 15 }}>{g.name}{g.count > 1 ? ` ×${g.count}` : ''}</Text>
                  {d.current && <Text style={[styles.badge, { borderRadius: th.r(8) }, { backgroundColor: t.accent, color: t.accentText }]}>{tr('devices.thisDevice')}</Text>}
                </View>
                <Text style={{ color: t.sub, fontSize: 12, marginTop: 2 }}>{tr('devices.lastSeen', { platform: d.platform, ago: fmtAgo(d.lastSeenAt) })}</Text>
              </View>
              <Btn small danger label={tr('tools.revoke')} onPress={() => revoke(d)} />
            </View>
          );
        })}
        {devices?.length === 0 && !err && <Text style={{ color: t.sub }}>{tr('devices.none')}</Text>}
        {stale.length > 0 && <Btn small danger label={tr('devices.revokeStale')} onPress={revokeStale} />}
        <Btn label={tr('common.refresh')} onPress={load} />
      </ScrollView>

      <Sheet visible={!!choice} onClose={() => setChoice(null)} title={tr('devices.convsTitle')} width={420}
        footer={
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Btn label={tr('devices.convsKeep')} onPress={() => { const c = choice; setChoice(null); if (c) void finishRevoke(c.list, false); }} />
            <Btn label={tr('devices.convsHide')} primary onPress={() => { const c = choice; setChoice(null); if (c) void finishRevoke(c.list, true); }} />
            <Btn label={tr('common.cancel')} onPress={() => setChoice(null)} />
          </View>
        }>
        <Text style={{ color: t.text, fontSize: 15, lineHeight: 21 }}>{tr('devices.convsMsg', { n: choice?.convs ?? 0 })}</Text>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { padding: 16, gap: 10, width: '100%', maxWidth: 720, alignSelf: 'center' },
  card: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, padding: 12 },
  badge: { fontSize: 11, fontWeight: '700', paddingHorizontal: 7, paddingVertical: 2, overflow: 'hidden' },
});
