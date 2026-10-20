import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { apiDev } from '../apiDev';
import { deliverText } from '../apiHistory';
import { modelLabel, useModelGroups } from '../ModelPicker';
import { fmtMs, fmtTps } from '../components/MetricsLine';
import BenchBarChart from '../components/BenchBarChart';
import Icon from '../components/Icon';
import { useBenchProgress } from '../devState';
import type { BenchRun, BenchSet, BenchSummaryRow } from '../protocol';
import { useTheme, useThemeDef } from '../theme';
import { useT } from '../i18n';
import { fmtDate as fmtDateTime } from '../historyTypes';
import { confirmDialog } from '../ui/confirm';
import { Btn, Hint, ScreenHeader } from '../ui/kit';
import { toast } from '../ui/toast';

const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });
const SHOW_STEP = 300;
const fmtDate = (ts?: number | null) => (ts ? fmtDateTime(ts) : '-');
const num = (v: number | null | undefined, f: (x: number) => string = (x) => x.toFixed(1)) => (v == null || !Number.isFinite(v) ? '-' : f(v));
const share = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '-' : `${Math.round(v <= 1 ? v * 100 : v)}%`);
export const isActive = (s?: string | null) => s === 'running' || s === 'queued' || s === 'pending';

/** Index of the summary row with the highest average decode speed (null when no row has a value). */
export function bestRow(rows: BenchSummaryRow[]): number | null {
  let best: number | null = null;
  rows.forEach((r, i) => {
    if (r.avgDecodeTps == null || !Number.isFinite(r.avgDecodeTps) || (r.n ?? 0) === 0) return;
    if (best === null || r.avgDecodeTps > (rows[best].avgDecodeTps as number)) best = i;
  });
  return best;
}

/** Table columns: `labelKey` is translated, a plain `label` is a technical name shown as is. */
const COLS: { key: string; w: number; labelKey?: string; label?: string }[] = [
  { key: 'model', w: 190, labelKey: 'bench.col.model' }, { key: 'quant', w: 80, labelKey: 'bench.col.quant' }, { key: 'ctx', w: 70, labelKey: 'bench.col.context' },
  { key: 'n', w: 44, label: 'n' }, { key: 'ttft', w: 84, label: 'Avg TTFT' }, { key: 'prefill', w: 96, label: 'Prefill tok/s' },
  { key: 'decode', w: 96, label: 'Decode tok/s' }, { key: 'p50', w: 92, label: 'p50 decode' }, { key: 'min', w: 64, labelKey: 'bench.col.min' },
  { key: 'max', w: 64, labelKey: 'bench.col.max' }, { key: 'err', w: 62, labelKey: 'bench.col.errors' }, { key: 'est', w: 84, labelKey: 'bench.col.share' },
];

/** One benchmark run: live progress, summary table (best row highlighted), bar chart, per-prompt rows, CSV, delete. */
export default function BenchResults({ runId, onBack, onDeleted }: { runId: string; onBack: () => void; onDeleted: () => void }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const { groups } = useModelGroups();
  const progress = useBenchProgress()[runId];
  const [run, setRun] = useState<BenchRun | null>(null);
  const [sets, setSets] = useState<BenchSet[]>([]);
  const [err, setErr] = useState('');
  const [showN, setShowN] = useState(SHOW_STEP);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setRun(await apiDev.benchRun(runId)); setErr(''); }
    catch (e: any) { setErr(e?.message || tr('bench.loadRunFailed')); }
  }, [runId, tr]);
  useEffect(() => { load(); apiDev.benchSets().then(setSets).catch(() => {}); }, [load]);

  const doneStatus = progress?.status;
  const active = !doneStatus && isActive(run?.status);
  // bench_done arrives on the socket: refetch the stored result
  useEffect(() => { if (doneStatus) load(); }, [doneStatus, load]);
  // fallback while running: a lost bench_done must not leave the page stuck
  useEffect(() => {
    if (!active) return;
    const h = setInterval(load, 5000);
    return () => clearInterval(h);
  }, [active, load]);

  const summary = run?.summary ?? [];
  const best = useMemo(() => bestRow(summary), [summary]);
  const set = sets.find((s) => s.id === run?.setId);
  const done = progress?.done ?? run?.done ?? 0;
  const total = progress?.total ?? run?.total ?? 0;
  const status = doneStatus || run?.status || '';

  const labelAt = (i: number): string => {
    const s = summary.find((x) => x.targetIndex === i);
    if (s) return s.model;
    const tg = run?.targets?.[i];
    return tg ? modelLabel(groups, { providerId: tg.providerId, model: tg.model }, undefined) : tr('bench.targetN', { n: i + 1 });
  };
  const rowLabel = (r: BenchSummaryRow) => `${r.model}${r.quantization ? ` · ${r.quantization}` : ''}${r.providerName ? ` (${r.providerName})` : ''}`;

  const cancel = async () => {
    setBusy(true);
    try { await apiDev.cancelBench(runId); toast(tr('bench.cancelling'), 'info'); load(); }
    catch (e: any) { toast(e?.message || tr('bench.cancelFailed'), 'error'); }
    setBusy(false);
  };
  const exportCsv = async () => {
    setBusy(true);
    try {
      const csv = await apiDev.benchCsv(runId);
      await deliverText(`omnichat-bench-${runId.slice(0, 8)}.csv`, csv, 'text/csv');
    } catch (e: any) { toast(e?.message || tr('bench.exportFailed'), 'error'); }
    setBusy(false);
  };
  const del = async () => {
    if (!(await confirmDialog(tr('bench.deleteRunTitle'), tr('bench.deleteRunBody'), tr('common.delete')))) return;
    try { await apiDev.deleteBench(runId); onDeleted(); }
    catch (e: any) { toast(e?.message || tr('bench.deleteFailed'), 'error'); }
  };

  const results = run?.results ?? [];
  const shown = results.slice(0, showN);
  const plural = (n: number, one: string, many: string) => tr(n === 1 ? one : many, { n });

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <ScreenHeader title={tr('bench.resultsTitle')} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.body}>
        {!!err && <Hint danger>{err}</Hint>}
        {!run && !err && <ActivityIndicator color={t.accentInk} style={{ margin: 20 }} />}
        {run && (
          <>
            <Text style={{ color: t.text, fontSize: 17, fontWeight: '700' }}>{run.setName || set?.name || tr('bench.defaultName')}</Text>
            <Text style={{ color: t.sub, fontSize: 12, marginTop: 2 }}>
              {fmtDate(run.startedAt)} · {status}{run.repeats ? ` · ${plural(run.repeats, 'bench.repeatsOne', 'bench.repeatsMany')}` : ''}{run.targets ? ` · ${plural(run.targets.length, 'bench.targetsOne', 'bench.targetsMany')}` : ''}
            </Text>

            {active && (
              <View style={[styles.card, { borderRadius: th.r(10) }, { borderColor: t.border, backgroundColor: t.panel }]}>
                <Text style={{ color: t.text, fontWeight: '600' }}>{tr('bench.running', { done, total })}</Text>
                <View style={{ height: 8, borderRadius: 4, backgroundColor: t.border, overflow: 'hidden', marginTop: 8 }}>
                  <View style={{ width: `${total ? Math.min(100, (done / total) * 100) : 0}%`, height: 8, backgroundColor: t.accent }} />
                </View>
                {!!progress?.current && <Text numberOfLines={1} style={{ color: t.sub, fontSize: 12, marginTop: 6 }}>{progress.current}</Text>}
                <View style={{ marginTop: 10 }}><Btn danger small label={tr('bench.cancelRun')} disabled={busy} onPress={cancel} /></View>
              </View>
            )}

            <Text style={[styles.h, { color: t.text }]}>{tr('bench.summary')}</Text>
            {summary.length === 0
              ? <Hint>{active ? tr('bench.summaryPending') : tr('bench.noSummary')}</Hint>
              : (
                <ScrollView horizontal style={[styles.tableWrap, { borderRadius: th.r(10) }, { borderColor: t.border }]} contentContainerStyle={{ minWidth: '100%' }}>
                  <View>
                    <View style={[styles.tr, { borderColor: t.border, backgroundColor: t.panel }]}>
                      {COLS.map((c) => <Text key={c.key} style={[styles.th, { width: c.w, color: t.sub }]}>{c.labelKey ? tr(c.labelKey) : c.label}</Text>)}
                    </View>
                    {summary.map((r, i) => {
                      const isBest = i === best;
                      const cells = [
                        rowLabel(r), r.quantization || '-', r.contextLength ? String(r.contextLength) : '-', String(r.n ?? 0),
                        fmtMs(r.avgTtftMs), fmtTps(r.avgPrefillTps), fmtTps(r.avgDecodeTps), fmtTps(r.p50DecodeTps),
                        fmtTps(r.minDecodeTps), fmtTps(r.maxDecodeTps), String(r.errors ?? 0), share(r.estimatedShare),
                      ];
                      return (
                        <View key={i} accessibilityLabel={isBest ? tr('bench.bestRow') : undefined} style={[styles.tr, { borderColor: t.border, backgroundColor: isBest ? t.userBubble : 'transparent' }]}>
                          {cells.map((c, k) => (
                            <Text key={k} numberOfLines={k === 0 ? 2 : 1} style={[styles.td, { width: COLS[k].w, color: t.text, fontWeight: isBest && (k === 0 || k === 6) ? '700' : '400' }, k > 0 && { fontFamily: mono }]}>
                              {c}{isBest && k === 0 ? <Icon name="star" size={11} color={t.text} /> : null}
                            </Text>
                          ))}
                        </View>
                      );
                    })}
                  </View>
                </ScrollView>
              )}
            {summary.length > 0 && <Hint>{tr('bench.legend')}</Hint>}

            {summary.length > 0 && (
              <BenchBarChart
                title={tr('bench.chartTitle')}
                unit="tok/s"
                bars={summary.map((r, i) => ({ label: rowLabel(r), value: r.avgDecodeTps, best: i === best }))}
              />
            )}

            <Text style={[styles.h, { color: t.text }]}>{tr('bench.perPrompt', { n: results.length })}</Text>
            {results.length === 0 && <Hint>{active ? tr('bench.rowsPending') : tr('bench.noRows')}</Hint>}
            {shown.map((r, i) => {
              const promptText = set?.prompts?.[r.promptIndex];
              return (
                <View key={i} style={[styles.card, { borderRadius: th.r(10) }, { borderColor: t.border, backgroundColor: t.panel, marginTop: 8 }]}>
                  <Text style={{ color: t.sub, fontSize: 12 }}>
                    {`P${r.promptIndex + 1} · r${r.repeat + 1} · ${labelAt(r.targetIndex)}`}
                    {r.status !== 'ok' && r.status !== 'done' ? ` · ${r.status}` : ''}
                  </Text>
                  <Text style={{ color: t.text, fontSize: 12, marginTop: 2, fontFamily: mono }}>
                    {`TTFT ${fmtMs(r.ttftMs)} · prefill ${fmtTps(r.prefillTps)} · decode ${fmtTps(r.decodeTps)} tok/s · ${r.completionTokens ?? '-'} tok · ${num(r.totalMs, (x) => fmtMs(x))}`}
                  </Text>
                  {!!promptText && <Text numberOfLines={1} style={{ color: t.sub, fontSize: 11, marginTop: 2 }}>{tr('bench.promptLabel')} {promptText}</Text>}
                  {!!r.error && <Text style={{ color: t.danger, fontSize: 12, marginTop: 2 }}>{r.error}</Text>}
                  {!!r.content && <Text numberOfLines={3} style={{ color: t.text, fontSize: 12, marginTop: 4, lineHeight: 17 }}>{r.content.slice(0, 160)}</Text>}
                </View>
              );
            })}
            {results.length > showN && <View style={{ marginTop: 8 }}><Btn small label={tr('bench.showMore', { n: results.length - showN })} onPress={() => setShowN(showN + SHOW_STEP)} /></View>}

            <View style={styles.actions}>
              <Btn label={tr('bench.exportCsv')} disabled={busy || active} onPress={exportCsv} />
              {!active && <Btn danger label={tr('bench.deleteRun')} onPress={del} />}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { padding: 16, width: '100%', maxWidth: 1100, alignSelf: 'center', paddingBottom: 40 },
  h: { fontSize: 15, fontWeight: '700', marginTop: 18, marginBottom: 6 },
  card: { borderWidth: 1, padding: 10, marginTop: 10 },
  tableWrap: { borderWidth: 1 },
  tr: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 34 },
  th: { paddingHorizontal: 8, paddingVertical: 8, fontSize: 11, fontWeight: '700' },
  td: { paddingHorizontal: 8, paddingVertical: 6, fontSize: 12 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 18 },
});
