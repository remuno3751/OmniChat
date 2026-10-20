import React, { useMemo } from 'react';
import { Text, View } from 'react-native';
import { useThemeDef, type Theme } from '../theme';
import { useT } from '../i18n';
import LineChart from './LineChart';

/*
 * ```chart fenced block: {type: "line"|"bar"|"pie", title?, labels?: string[], series: [{name, data: number[]}]}
 * Drawn with plain Views (no chart or SVG dependency). Invalid specs show the raw block plus an "invalid chart" note.
 */

export interface ChartSeries { name: string; data: (number | null)[] }
export interface ChartSpec { type: 'line' | 'bar' | 'pie'; title?: string; labels?: string[]; series: ChartSeries[] }

const PALETTE = ['#10a37f', '#6366f1', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#84cc16', '#ec4899'];
const MAX_POINTS = 500;
const MAX_SERIES = 12;
const H = 140;

/** Returns a validated spec, or null when the JSON or its shape is wrong. */
export function parseChart(src: string): ChartSpec | null {
  let o: any;
  try { o = JSON.parse(src); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (o.type !== 'line' && o.type !== 'bar' && o.type !== 'pie') return null;
  if (!Array.isArray(o.series) || o.series.length < 1 || o.series.length > MAX_SERIES) return null;
  if (o.title !== undefined && typeof o.title !== 'string') return null;
  if (o.labels !== undefined && (!Array.isArray(o.labels) || o.labels.some((l: unknown) => typeof l !== 'string'))) return null;
  const series: ChartSeries[] = [];
  for (const s of o.series) {
    if (!s || typeof s !== 'object' || typeof s.name !== 'string' || !Array.isArray(s.data)) return null;
    if (s.data.length > MAX_POINTS) return null;
    if (s.data.some((v: unknown) => v !== null && (typeof v !== 'number' || !Number.isFinite(v)))) return null;
    series.push({ name: s.name, data: s.data });
  }
  if (o.type === 'pie') {
    const d = series[0].data;
    if (d.some((v) => v == null || v < 0) || d.reduce((a: number, v) => a + (v ?? 0), 0) <= 0) return null;
  }
  return { type: o.type, title: o.title, labels: o.labels, series };
}

export default function ChartBlock({ source, t, fallback }: { source: string; t: Theme; fallback: React.ReactNode }) {
  const tr = useT();
  const th = useThemeDef();
  const spec = useMemo(() => parseChart(source), [source]);
  if (!spec) {
    return (
      <View>
        {fallback}
        <Text style={{ color: t.warn, fontSize: 12, marginBottom: 6 }}>{tr('chart.invalid')}</Text>
      </View>
    );
  }
  const labels = spec.labels ?? [];
  const color = (k: number) => PALETTE[k % PALETTE.length];

  if (spec.type === 'line') {
    return (
      <View style={{ marginVertical: 6 }}>
        <LineChart
          title={spec.title ?? ''}
          height={H}
          series={spec.series.map((s, k) => ({ name: s.name, color: color(k), unit: '', points: s.data }))}
        />
        {labels.length > 0 && (
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 }}>
            <Text style={{ color: t.sub, fontSize: 10 }}>{labels[0]}</Text>
            <Text style={{ color: t.sub, fontSize: 10 }}>{labels[labels.length - 1]}</Text>
          </View>
        )}
      </View>
    );
  }

  const header = spec.title ? (
    <Text style={{ color: t.text, fontSize: 13, fontWeight: '600', marginBottom: 4 }}>{spec.title}</Text>
  ) : null;

  if (spec.type === 'bar') {
    const all = spec.series.flatMap((s) => s.data.filter((v): v is number => v != null));
    const max = all.length ? Math.max(0, ...all) || 1 : 1;
    const n = Math.max(0, ...spec.series.map((s) => s.data.length));
    return (
      <View style={{ marginVertical: 6 }}>
        {header}
        <View style={{ height: H, flexDirection: 'row', alignItems: 'flex-end', gap: 6, paddingHorizontal: 4, borderBottomWidth: 1, borderColor: t.border }}>
          {Array.from({ length: n }, (_, i) => (
            <View key={i} style={{ flex: 1, height: '100%', flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: 2 }}>
              {spec.series.map((s, k) => {
                const v = s.data[i];
                const h = v == null ? 0 : Math.max(0, (v / max) * (H - 20));
                return (
                  <View
                    key={k}
                    accessibilityLabel={`${s.name} ${v ?? tr('chart.noValue')}`}
                    style={{ flex: 1, maxWidth: 28, height: h, minHeight: v ? 1 : 0, backgroundColor: color(k), borderTopLeftRadius: 3, borderTopRightRadius: 3 }}
                  />
                );
              })}
            </View>
          ))}
        </View>
        {labels.length > 0 && (
          <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 4, marginTop: 3 }}>
            {Array.from({ length: n }, (_, i) => (
              <Text key={i} numberOfLines={1} style={{ flex: 1, color: t.sub, fontSize: 10, textAlign: 'center' }}>{labels[i] ?? ''}</Text>
            ))}
          </View>
        )}
        <Legend spec={spec} t={t} color={color} />
      </View>
    );
  }

  // pie: one 100% stacked bar of the first series, with a legend giving the share of each slice
  const data = spec.series[0].data.map((v) => v ?? 0);
  const total = data.reduce((a, v) => a + v, 0);
  return (
    <View style={{ marginVertical: 6 }}>
      {header}
      <View style={{ height: 18, flexDirection: 'row', borderRadius: 9, overflow: 'hidden', backgroundColor: t.panel }}>
        {data.map((v, i) => v > 0 && <View key={i} accessibilityLabel={labels[i] ?? tr('chart.item', { n: i + 1 })} style={{ flex: v, backgroundColor: color(i) }} />)}
      </View>
      <View style={{ marginTop: 6, gap: 3 }}>
        {data.map((v, i) => (
          <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 10, height: 10, borderRadius: th.r(2), backgroundColor: color(i) }} />
            <Text numberOfLines={1} style={{ flex: 1, color: t.text, fontSize: 12 }}>{labels[i] ?? tr('chart.item', { n: i + 1 })}</Text>
            <Text style={{ color: t.sub, fontSize: 12 }}>{`${v} (${((v / total) * 100).toFixed(1)}%)`}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function Legend({ spec, t, color }: { spec: ChartSpec; t: Theme; color: (k: number) => string }) {
  const th = useThemeDef();
  if (spec.series.length < 2) return null;
  return (
    <View style={{ flexDirection: 'row', gap: 12, marginTop: 4, flexWrap: 'wrap' }}>
      {spec.series.map((s, k) => (
        <View key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <View style={{ width: 10, height: 10, borderRadius: th.r(2), backgroundColor: color(k) }} />
          <Text style={{ color: t.sub, fontSize: 11 }}>{s.name}</Text>
        </View>
      ))}
    </View>
  );
}
