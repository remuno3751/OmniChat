import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ROUTE_LABEL, avgRtt, latState, useNet } from '../net';
import { reconnectNow } from '../socket';
import { useStore } from '../store';
import { useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';
import { Btn, Hint, Sheet, useWide } from '../ui/kit';
import { useFaces } from '../ui/skin';

/** Header latency indicator: average of the last RTTs, colour state, route label; tap for details. */
export default function LatencyBadge() {
  const t = useTheme();
  const th = useThemeDef();
  const bars = th.def.id === 'frontier';
  const tr = useT();
  const faces = useFaces();
  const wide = useWide(560);
  const connected = useStore((s) => s.connected);
  const rtts = useNet((n) => n.rtts);
  const route = useNet((n) => n.route);
  const [open, setOpen] = useState(false);
  const avg = avgRtt(rtts);
  const state = latState(avg, connected);
  const color = state === 'good' ? t.good : state === 'slow' ? t.warn : state === 'bad' ? t.danger : t.sub;
  const text = state === 'off' ? tr('msg.latency.offline') : avg == null ? '...' : `${avg} ms`;
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={route ? tr('msg.latency.a11yRoute', { text, route: ROUTE_LABEL[route] }) : tr('msg.latency.a11y', { text })}
        hitSlop={6}
        style={[styles.pill, { borderColor: color, borderRadius: th.r(12) }, bars && { borderWidth: 0, paddingHorizontal: 2 }, th.def.variants.bubble === 'card' && { borderColor: t.borderStrong + '80' }]}
      >
        {bars ? (
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 11 }}>
            {[4, 7, 11].map((h, i) => (
              <View key={h} style={{ width: 3, height: h, backgroundColor: state === 'off' || (state === 'bad' && i > 0) || (state === 'slow' && i > 1) ? t.borderStrong : color }} />
            ))}
          </View>
        ) : <View style={[styles.dot, { backgroundColor: color }]} />}
        <Text style={[{ color, fontSize: 11, fontWeight: '600' }, faces.num, bars && { color: state === 'off' ? t.sub : t.text, fontSize: 13 }]}>{text}</Text>
        {!!route && wide && <Text style={[{ color: t.sub, fontSize: 11 }, faces.label, bars && { fontSize: 10 }]}>{ROUTE_LABEL[route]}</Text>}
      </Pressable>
      <LatencySheet visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

function LatencySheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useTheme();
  const tr = useT();
  const connected = useStore((s) => s.connected);
  const net = useNet((n) => n);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [visible]);
  const avg = avgRtt(net.rtts);
  const state = latState(avg, connected);
  const status = state === 'off'
    ? net.httpUp ? tr('sheet.connection.wsDown') : tr('sheet.connection.disconnected')
    : state === 'good' ? tr('sheet.connection.good') : state === 'slow' ? tr('sheet.connection.slow') : tr('sheet.connection.bad');
  const off = net.offsetMs;
  const row = (k: string, v: string) => (
    <View style={styles.row}>
      <Text style={{ color: t.sub, fontSize: 14 }}>{k}</Text>
      <Text style={{ color: t.text, fontSize: 14, flexShrink: 1, textAlign: 'right' }}>{v}</Text>
    </View>
  );
  return (
    <Sheet visible={visible} onClose={onClose} title={tr('sheet.connection.title')} width={400}
      footer={<Btn primary label={tr('sheet.connection.reconnect')} onPress={() => { reconnectNow(); }} />}>
      {row(tr('sheet.connection.status'), status)}
      {row(tr('sheet.connection.average', { n: net.rtts.length }), avg == null ? '-' : `${avg} ms`)}
      {row(tr('sheet.connection.pings'), net.rtts.length ? [...net.rtts].reverse().map((x) => `${x}`).join(', ') + ' ms' : '-')}
      {row(tr('sheet.connection.measured'), net.via === 'ws' ? 'WebSocket' : net.via === 'http' ? 'HTTP /ping' : '-')}
      {row(tr('sheet.connection.route'), net.route ? ROUTE_LABEL[net.route] : tr('msg.unknown'))}
      {row(tr('sheet.connection.offset'), off == null ? tr('msg.unknown') : `${off > 0 ? '+' : ''}${off} ms`)}
      {!connected && net.retryAt != null && row(tr('sheet.connection.nextAttempt'), tr('sheet.connection.nextIn', { s: Math.max(0, Math.ceil((net.retryAt - now) / 1000)), n: net.attempt }))}
      <Hint>{tr('sheet.connection.hint')}</Hint>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, paddingHorizontal: 7, paddingVertical: 3 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 6 },
});
