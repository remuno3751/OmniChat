import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { ApiError, api } from '../api';
import LineChart from '../components/LineChart';
import { fmtMs, fmtTps } from '../components/MetricsLine';
import { useT } from '../i18n';
import type { StatGroup, StatPoint, StatsResponse } from '../protocol';
import { useTheme, useThemeDef } from '../theme';
import { Btn, Hint, Label, ScreenHeader, Segmented } from '../ui/kit';
import { toast } from '../ui/toast';

type Range = 'all' | '30d' | '24h';
const RANGE_MS: Record<Range, number> = { all: 0, '30d': 30 * 86400000, '24h': 86400000 };
const avg = (a: (number | null)[]) => { const v = a.filter((x): x is number => x != null); return v.length ? v.reduce((p, c) => p + c, 0) / v.length : null; };
const pct = (v: number | null | undefined) => (v == null ? '-' : `${Math.round(v * 100)}%`);
const ctxText = (v: number | null | undefined) => (v ? (v >= 1000 ? `${Math.round(v / 1024)}k` : String(v)) : '-');

const colsFor = (tr: (key: string) => string): { k: string; label: string; w: number }[] => [
  { k: 'model', label: tr('stats.colModel'), w: 150 }, { k: 'q', label: tr('stats.colQuant'), w: 64 }, { k: 'ctx', label: tr('stats.colContext'), w: 62 }, { k: 'n', label: tr('stats.colCount'), w: 52 },
  { k: 'ttft', label: tr('stats.colTtft'), w: 74 }, { k: 'pre', label: tr('stats.colPrefill'), w: 80 }, { k: 'dec', label: tr('stats.colDecode'), w: 84 }, { k: 'est', label: tr('stats.colEst'), w: 46 },
];

/** Settings > Statistics: overall / recent / per-model speed numbers, a small line chart and CSV export. */
export default function StatsScreen({ onBack }: { onBack: () => void }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const [data, setData] = useState<StatsResponse | null>(null);
  const [err, setErr] = useState('');
  const [range, setRange] = useState<Range>('all');
  const [recentN, setRecentN] = useState<'10' | '20' | '50'>('20');
  const [model, setModel] = useState<string>('');

  const load = useCallback(async () => {
    try {
      const r = await api.stats(RANGE_MS[range] ? Date.now() - RANGE_MS[range] : undefined, parseInt(recentN, 10));
      setData(r); setErr('');
    } catch (e: any) {
      setData(null);
      setErr(e instanceof ApiError && (e.status === 404 || e.status === 501) ? tr('stats.noServer') : e.message || String(e));
    }
  }, [range, recentN, tr]);
  useEffect(() => { setData(null); load(); }, [load]);

  const models = useMemo(() => Array.from(new Set((data?.byModel || []).map((m) => m.model))), [data]);
  useEffect(() => { if (model && data && !models.includes(model)) setModel(''); }, [models, model, data]);
  const series: StatPoint[] = useMemo(() => (data?.series || []).filter((p) => !model || p.model === model), [data, model]);
  const rows = useMemo(() => (data?.byModel || []).filter((m) => !model || m.model === model), [data, model]);

  const filtered = useMemo<StatGroup | null>(() => model ? {
    count: rows.reduce((a, r) => a + r.count, 0), avgTtftMs: avg(series.map((p) => p.ttftMs)), avgPrefillTps: avg(series.map((p) => p.prefillTps)),
    avgDecodeTps: avg(series.map((p) => p.decodeTps)),
  } : null, [model, rows, series]);

  const exportCsv = async () => {
    try {
      const csv = await api.statsExport();
      if (Platform.OS === 'web') {
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const a = document.createElement('a');
        a.href = url; a.download = 'omnichat-metrics.csv';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        toast(tr('stats.csvDownloaded'), 'ok');
      } else {
        try { await Share.share({ message: csv, title: 'omnichat-metrics.csv' }); }
        catch { toast(tr('stats.shareUnavailable'), 'error'); }
      }
    } catch (e: any) {
      toast(e instanceof ApiError && e.status === 404 ? tr('stats.exportUnsupported') : e.message || tr('sheet.export.failed'), 'error');
    }
  };

  const groupCard = (title: string, g: StatGroup | null | undefined, sub?: string) => (
    <View style={[styles.card, { borderRadius: th.r(12) }, { borderColor: t.border, backgroundColor: t.panel }]}>
      <Text style={{ color: t.text, fontWeight: '700', fontSize: 14 }}>{title}</Text>
      <Text style={{ color: t.sub, fontSize: 11, marginBottom: 6 }}>{sub ?? tr('stats.replies', { n: g?.count ?? g?.n ?? 0 })}</Text>
      <Text style={{ color: t.text, fontSize: 13 }}>{tr('msg.metrics.ttft', { v: fmtMs(g?.avgTtftMs) })}</Text>
      <Text style={{ color: t.text, fontSize: 13 }}>{tr('stats.prefillLine', { v: fmtTps(g?.avgPrefillTps) })}</Text>
      <Text style={{ color: t.text, fontSize: 13 }}>{tr('stats.decodeLine', { v: fmtTps(g?.avgDecodeTps) })}</Text>
      {g?.estimatedShare != null && <Text style={{ color: t.sub, fontSize: 11, marginTop: 2 }}>{tr('stats.estimated', { v: pct(g.estimatedShare) })}</Text>}
    </View>
  );

  const cols = colsFor(tr);

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <ScreenHeader title={tr('settings.statistics')} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.body}>
        {!data && !err && <ActivityIndicator color={t.accentInk} style={{ margin: 20 }} />}
        {!!err && <Hint danger>{err}</Hint>}
        {data && (
          <>
            <Label>{tr('stats.period')}</Label>
            <Segmented<Range> options={[{ value: 'all', label: tr('stats.allTime') }, { value: '30d', label: tr('stats.days30') }, { value: '24h', label: tr('stats.hours24') }]} value={range} onChange={setRange} />
            <Label>{tr('stats.recentReplies')}</Label>
            <Segmented options={[{ value: '10', label: tr('stats.last', { n: 10 }) }, { value: '20', label: tr('stats.last', { n: 20 }) }, { value: '50', label: tr('stats.last', { n: 50 }) }]} value={recentN} onChange={setRecentN} />
            {models.length > 1 && (
              <>
                <Label>{tr('stats.modelFilter')}</Label>
                <Segmented<string> options={[{ value: '', label: tr('stats.allModels') }, ...models.map((m) => ({ value: m, label: m }))]} value={model} onChange={setModel} />
              </>
            )}
            <View style={styles.cards}>
              {filtered ? groupCard(tr('stats.filtered'), filtered, tr('stats.repliesIn', { n: filtered.count ?? 0, model })) : groupCard(tr('stats.overall'), data.overall)}
              {groupCard(tr('stats.recentN', { n: recentN }), data.recent, tr('stats.replies', { n: data.recent?.n ?? data.recent?.count ?? 0 }))}
            </View>
            {data.overall?.count === 0 && <Hint>{tr('stats.noMeasured')}</Hint>}

            <Text style={[styles.section, { color: t.text }]}>{tr('stats.byModel')}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator>
              <View>
                <View style={[styles.tr, { borderColor: t.border }]}>
                  {cols.map((c) => <Text key={c.k} style={[styles.th, { width: c.w, color: t.sub }]}>{c.label}</Text>)}
                </View>
                {rows.map((r, i) => {
                  const cells: Record<string, string> = {
                    model: r.model + (r.providerName ? ` (${r.providerName})` : ''), q: r.quantization || '-', ctx: ctxText(r.contextLength), n: String(r.count),
                    ttft: fmtMs(r.avgTtftMs), pre: fmtTps(r.avgPrefillTps), dec: fmtTps(r.avgDecodeTps), est: pct(r.estimatedShare),
                  };
                  return (
                    <View key={i} style={[styles.tr, { borderColor: t.border }]}>
                      {cols.map((c) => <Text key={c.k} numberOfLines={2} style={[styles.td, { width: c.w, color: t.text }]}>{cells[c.k]}</Text>)}
                    </View>
                  );
                })}
                {!rows.length && <Text style={{ color: t.sub, fontSize: 12, padding: 8 }}>{tr('stats.noData')}</Text>}
              </View>
            </ScrollView>
            <Hint>{tr('stats.groupingHint')}</Hint>

            <Text style={[styles.section, { color: t.text }]}>{tr('stats.trend', { n: series.length })}</Text>
            <LineChart title={tr('stats.decodeSpeed')} series={[{ name: 'decode tok/s', color: t.accentInk, unit: 'tok/s', points: series.map((p) => p.decodeTps) }]} />
            <LineChart title={tr('stats.ttftTitle')} series={[{ name: 'TTFT ms', color: t.warn, unit: 'ms', points: series.map((p) => p.ttftMs) }]} />

            <View style={{ marginTop: 16 }}><Btn label={tr('stats.exportCsv')} onPress={exportCsv} /></View>
            {Platform.OS !== 'web' && <Hint>{tr('stats.shareHint')}</Hint>}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { padding: 16, gap: 2, width: '100%', maxWidth: 720, alignSelf: 'center' },
  section: { fontSize: 16, fontWeight: '700', marginTop: 20 },
  cards: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 },
  card: { flexGrow: 1, flexBasis: 150, borderWidth: 1, padding: 12 },
  tr: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 6 },
  th: { fontSize: 11, fontWeight: '700', paddingHorizontal: 4 },
  td: { fontSize: 12, paddingHorizontal: 4 },
});
