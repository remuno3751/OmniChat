import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiError, api } from '../api';
import { useT } from '../i18n';
import type { Device } from '../protocol';
import { useTheme, useThemeDef } from '../theme';
import { confirmDialog } from '../ui/confirm';
import { Btn, Hint, ScreenHeader, fmtAgo } from '../ui/kit';
import { toast } from '../ui/toast';

/** Settings > Devices: every signed-in device with last-seen and Revoke. */
export default function DevicesScreen({ onBack, onLoggedOut }: { onBack: () => void; onLoggedOut: () => void }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api.devices();
      setDevices([...(r.devices || [])].sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt));
      setErr('');
    } catch (e: any) {
      setErr(e instanceof ApiError && e.status === 404 ? tr('devices.unsupported') : e.message || String(e));
      setDevices([]);
    }
  }, [tr]);
  useEffect(() => { load(); }, [load]);

  const revoke = async (d: Device) => {
    const ok = await confirmDialog(
      d.current ? tr('devices.revokeThisTitle') : tr('devices.revokeTitle'),
      d.current ? tr('devices.revokeThisMsg') : tr('devices.revokeMsg', { name: d.name }),
      tr('tools.revoke'),
    );
    if (!ok) return;
    try {
      await api.revokeDevice(d.id);
      if (d.current) { onLoggedOut(); return; }
      toast(tr('devices.revoked'), 'ok');
      load();
    } catch (e: any) { toast(e.message || tr('devices.revokeFailed'), 'error'); }
  };

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <ScreenHeader title={tr('settings.devices')} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.body}>
        <Hint>{tr('devices.hint')}</Hint>
        {devices === null && <ActivityIndicator color={t.accentInk} style={{ margin: 20 }} />}
        {!!err && <Hint danger>{err}</Hint>}
        {devices?.map((d) => (
          <View key={d.id} style={[styles.card, { borderRadius: th.r(12) }, { borderColor: t.border, backgroundColor: t.panel }]}>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Text style={{ color: t.text, fontWeight: '600', fontSize: 15 }}>{d.name}</Text>
                {d.current && <Text style={[styles.badge, { borderRadius: th.r(8) }, { backgroundColor: t.accent, color: t.accentText }]}>{tr('devices.thisDevice')}</Text>}
              </View>
              <Text style={{ color: t.sub, fontSize: 12, marginTop: 2 }}>{tr('devices.lastSeen', { platform: d.platform, ago: fmtAgo(d.lastSeenAt) })}</Text>
            </View>
            <Btn small danger label={tr('tools.revoke')} onPress={() => revoke(d)} />
          </View>
        ))}
        {devices?.length === 0 && !err && <Text style={{ color: t.sub }}>{tr('devices.none')}</Text>}
        <Btn label={tr('common.refresh')} onPress={load} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { padding: 16, gap: 10, width: '100%', maxWidth: 720, alignSelf: 'center' },
  card: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, padding: 12 },
  badge: { fontSize: 11, fontWeight: '700', paddingHorizontal: 7, paddingVertical: 2, overflow: 'hidden' },
});
