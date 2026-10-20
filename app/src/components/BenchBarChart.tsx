import React from 'react';
import { Text, View } from 'react-native';
import { useTheme, useThemeDef } from '../theme';

export interface Bar { label: string; value: number | null | undefined; best?: boolean }

/** Minimal horizontal bar chart (Views only, same spirit as LineChart): one bar per target, scaled to the largest value. */
export default function BenchBarChart({ title, unit, bars }: { title: string; unit: string; bars: Bar[] }) {
  const t = useTheme();
  const th = useThemeDef();
  const vals = bars.map((b) => (b.value != null && Number.isFinite(b.value) ? b.value : 0));
  const max = Math.max(0, ...vals);
  const fmt = (v: number) => (v >= 100 ? Math.round(v).toString() : v.toFixed(1));
  return (
    <View style={{ marginTop: 14 }} accessibilityLabel={title}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <Text style={{ color: t.text, fontSize: 13, fontWeight: '600', flexShrink: 1 }}>{title}</Text>
        <Text style={{ color: t.sub, fontSize: 11 }}>{unit}</Text>
      </View>
      <View style={{ marginTop: 6, gap: 8, borderWidth: 1, borderColor: t.border, borderRadius: th.r(8), padding: 10, backgroundColor: t.panel }}>
        {bars.map((b, i) => {
          const v = vals[i];
          const w = max > 0 ? (v / max) * 100 : 0;
          const has = b.value != null && Number.isFinite(b.value);
          return (
            <View key={i} style={{ gap: 3 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                <Text numberOfLines={1} style={{ color: b.best ? t.good : t.text, fontSize: 12, flexShrink: 1 }}>{b.label}</Text>
                <Text style={{ color: b.best ? t.good : t.text, fontSize: 12, fontWeight: '700' }}>{has ? fmt(v) : '-'}</Text>
              </View>
              <View style={{ height: 10, borderRadius: 5, backgroundColor: t.border, overflow: 'hidden' }}>
                <View style={{ width: `${Math.max(has && v > 0 ? 2 : 0, w)}%`, height: 10, borderRadius: 5, backgroundColor: b.best ? t.good : t.accent }} />
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}
