import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { useTheme, useThemeDef } from '../theme';
import { useT } from '../i18n';

export interface Series { name: string; color: string; points: (number | null)[]; unit: string }

/** Minimal hand-written line chart (Views only, no chart/svg dependency). All series share the x axis (index). */
export default function LineChart({ series, height = 120, title }: { series: Series[]; height?: number; title: string }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const [w, setW] = useState(0);
  const vals = series.flatMap((s) => s.points.filter((p): p is number => p != null));
  const n = Math.max(0, ...series.map((s) => s.points.length));
  const max = vals.length ? Math.max(...vals) : 1;
  const pad = 6;
  const iw = Math.max(1, w - pad * 2), ih = height - pad * 2;
  const X = (i: number) => pad + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const Y = (v: number) => pad + ih - (max > 0 ? (v / max) * ih : 0);
  return (
    <View style={{ marginTop: 10 }} accessibilityLabel={title}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Text style={{ color: t.text, fontSize: 13, fontWeight: '600' }}>{title}</Text>
        <Text style={{ color: t.sub, fontSize: 11 }}>{tr('chart.max', { v: max >= 100 ? Math.round(max) : max.toFixed(1) })} {series[0]?.unit}</Text>
      </View>
      <View style={[{ height, marginTop: 4, borderWidth: 1, borderColor: t.border, overflow: 'hidden', backgroundColor: t.panel }, { borderRadius: th.r(8) }]} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
        {[0.5, 1].map((f) => <View key={f} style={{ position: 'absolute', left: 0, right: 0, top: pad + ih * (1 - f), height: 1, backgroundColor: t.border }} />)}
        {w > 0 && !vals.length && <Text style={{ color: t.sub, fontSize: 12, padding: 8 }}>{tr('chart.noData')}</Text>}
        {w > 0 && series.map((s) => {
          const els: React.ReactNode[] = [];
          let prev: { x: number; y: number } | null = null;
          s.points.forEach((v, i) => {
            if (v == null) { prev = null; return; }
            const x = X(i), y = Y(v);
            if (prev) {
              const dx = x - prev.x, dy = y - prev.y, len = Math.sqrt(dx * dx + dy * dy);
              els.push(
                <View key={'l' + i} style={{
                  position: 'absolute', left: (x + prev.x) / 2 - len / 2, top: (y + prev.y) / 2 - 1, width: len, height: 2,
                  backgroundColor: s.color, transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }],
                }} />,
              );
            }
            els.push(<View key={'p' + i} style={{ position: 'absolute', left: x - 2.5, top: y - 2.5, width: 5, height: 5, borderRadius: 3, backgroundColor: s.color }} />);
            prev = { x, y };
          });
          return <React.Fragment key={s.name}>{els}</React.Fragment>;
        })}
      </View>
      <View style={{ flexDirection: 'row', gap: 12, marginTop: 4, flexWrap: 'wrap' }}>
        {series.map((s) => (
          <View key={s.name} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View style={{ width: 10, height: 3, backgroundColor: s.color }} />
            <Text style={{ color: t.sub, fontSize: 11 }}>{s.name}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}
