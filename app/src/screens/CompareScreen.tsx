import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { apiDev } from '../apiDev';
import { ApiError } from '../api';
import ModelPicker, { modelLabel, useModelGroups } from '../ModelPicker';
import type { ModelSel } from '../store';
import { activeProviders, useStore } from '../store';
import type { ComparisonRow, CompareTarget, ResponseFormat } from '../protocol';
import CompareColumn, { bestOf } from '../components/CompareColumn';
import ResponseFormatEditor, { draftToRF, emptyRF } from '../components/ResponseFormatEditor';
import type { RFDraft } from '../components/ResponseFormatEditor';
import { clearCompareRun, startCompare, stopCompare, useCompareRun } from '../devState';
import type { CompareCol } from '../devState';
import { useTheme, useThemeDef } from '../theme';
import { useT } from '../i18n';
import { fmtDate } from '../historyTypes';
import { Btn, Field, Hint, Label, ScreenHeader, Segmented, useWide } from '../ui/kit';
import { confirmDialog } from '../ui/confirm';
import { toast } from '../ui/toast';

const MAX_TARGETS = 4;

/** What the results area shows: the live run or a saved comparison opened from the list. */
interface Panel { title: string; prompt: string; targets: CompareTarget[]; cols: CompareCol[] }

/** Developer-mode model comparison: same prompt to 1-4 targets, streamed side by side (desktop) or as tabs (phone). */
export default function CompareScreen({ onBack }: { onBack: () => void }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const wide = useWide(700);
  const run = useCompareRun();
  const providers = useStore((s) => s.providers);
  const lastSel = useStore((s) => s.lastSel);
  const { groups } = useModelGroups();
  const hasProviders = activeProviders(providers).length > 0;

  const [prompt, setPrompt] = useState('');
  const [system, setSystem] = useState('');
  const [targets, setTargets] = useState<(ModelSel | null)[]>([lastSel ?? null]);
  const [sequential, setSequential] = useState(true);
  const [rf, setRf] = useState<RFDraft>(emptyRF());
  const [tab, setTab] = useState(0);
  const [err, setErr] = useState('');
  const [past, setPast] = useState<ComparisonRow[] | null>(null);
  const [pastErr, setPastErr] = useState('');
  const [pastUnsupported, setPastUnsupported] = useState(false);
  const [viewing, setViewing] = useState<Panel | null>(null);
  const [opening, setOpening] = useState(false);

  const busy = !!run && !run.complete;
  const labelOf = useCallback((tg: { providerId: string; model: string }) => {
    const p = providers[tg.providerId]?.name;
    const m = modelLabel(groups, { providerId: tg.providerId, model: tg.model }, undefined);
    return p ? `${m} · ${p}` : m;
  }, [providers, groups]);

  const loadPast = useCallback(async () => {
    try { setPast(await apiDev.comparisons()); setPastErr(''); setPastUnsupported(false); }
    catch (e: any) {
      const unsup = e instanceof ApiError && e.status === 404;
      setPast([]);
      setPastUnsupported(unsup);
      setPastErr(unsup ? tr('compare.unsupported') : e?.message || tr('compare.loadFailed'));
    }
  }, [tr]);
  useEffect(() => { loadPast(); }, [loadPast]);
  useEffect(() => { if (run?.complete) loadPast(); }, [run?.complete, loadPast]);
  // leaving the screen with a finished run clears it; a running one keeps streaming in the background
  useEffect(() => () => clearCompareRun(), []);

  const setTarget = (i: number, s: ModelSel) => setTargets((ts) => ts.map((x, k) => (k === i ? s : x)));
  const removeTarget = (i: number) => setTargets((ts) => ts.filter((_, k) => k !== i));

  const start = () => {
    setErr('');
    if (busy) return;
    if (!prompt.trim()) { setErr(tr('compare.errPrompt')); return; }
    const chosen = targets.filter((s): s is ModelSel => !!s);
    if (!chosen.length) { setErr(tr('compare.errModel')); return; }
    const r = draftToRF(rf);
    if (r.error) { setErr(r.error); return; }
    const tg: CompareTarget[] = chosen.map((s) => {
      const c: CompareTarget = { providerId: s.providerId, model: s.model || providers[s.providerId]?.model || '' };
      if (r.value) c.responseFormat = r.value as ResponseFormat;
      return c;
    });
    setViewing(null);
    setTab(0);
    const e = startCompare({ prompt, systemPrompt: system.trim() ? system : null, targets: tg, sequential });
    if (e) setErr(e);
  };

  const open = async (id: string) => {
    setOpening(true); setErr('');
    try {
      const row = await apiDev.comparison(id);
      const results = row.results || [];
      const cols: CompareCol[] = row.targets.map((tg, i) => {
        const r = results.find((x) => (x.index ?? -1) === i) ?? results[i];
        return r
          ? { status: r.status, content: r.content ?? '', reasoning: r.reasoning ?? '', metrics: r.metrics ?? null, error: r.error }
          : { status: 'error', content: '', reasoning: '', metrics: null, error: tr('compare.noResult') };
      });
      setViewing({ title: fmtDate(row.createdAt), prompt: row.prompt, targets: row.targets, cols });
      setTab(0);
    } catch (e: any) { toast(e?.message || tr('compare.openFailed'), 'error'); }
    setOpening(false);
  };

  const remove = async (row: ComparisonRow) => {
    if (!(await confirmDialog(tr('compare.deleteTitle'), tr('compare.deleteBody'), tr('common.delete')))) return;
    try {
      await apiDev.deleteComparison(row.id);
      setPast((p) => (p || []).filter((x) => x.id !== row.id));
    } catch (e: any) { toast(e?.message || tr('compare.deleteFailed'), 'error'); }
  };

  const live: Panel | null = run ? { title: 'Live', prompt: run.prompt, targets: run.targets, cols: run.cols } : null;
  const panel = viewing ?? live;
  const best = panel ? bestOf(panel.cols) : null;
  const idx = panel ? Math.min(tab, panel.cols.length - 1) : 0;

  const unavailable = past !== null && pastUnsupported;

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <ScreenHeader title={tr('dev.compare')} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {unavailable && <Hint danger>{pastErr}</Hint>}
        <Field label={tr('compare.prompt')} value={prompt} onChangeText={setPrompt} multiline minHeight={90} placeholder={tr('compare.promptPlaceholder')} />
        <Field label={tr('compare.system')} value={system} onChangeText={setSystem} multiline minHeight={44} placeholder={tr('compare.noneSystem')} />

        <Label>{tr('compare.targets', { max: MAX_TARGETS })}</Label>
        {targets.map((s, i) => (
          <View key={i} style={styles.targetRow}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <ModelPicker
                sel={s}
                providerName={providers[s?.providerId ?? '']?.name ?? ''}
                fallbackModel={providers[s?.providerId ?? '']?.model}
                hasProviders={hasProviders}
                onSelect={(x) => setTarget(i, x)}
                onAddProvider={() => toast(tr('compare.addProviderFirst'), 'info')}
              />
            </View>
            {targets.length > 1 && <Btn small label={tr('compare.remove')} onPress={() => removeTarget(i)} />}
          </View>
        ))}
        {targets.length < MAX_TARGETS && <Btn small label={tr('compare.addTarget')} onPress={() => setTargets((ts) => [...ts, null])} style={{ marginTop: 6 }} />}

        <Label>{tr('compare.order')}</Label>
        <Segmented<'seq' | 'par'>
          options={[{ value: 'seq', label: tr('compare.seq') }, { value: 'par', label: tr('compare.par') }]}
          value={sequential ? 'seq' : 'par'}
          onChange={(v) => setSequential(v === 'seq')}
        />
        <Hint>{sequential ? tr('compare.seqHint') : tr('compare.parHint')}</Hint>

        <View style={{ marginTop: 8 }}>
          <ResponseFormatEditor value={rf} onChange={setRf} label={tr('compare.responseFormat')} compact />
        </View>

        {!!err && <Hint danger>{err}</Hint>}
        <View style={styles.actions}>
          {busy
            ? <Btn danger label={tr('common.stop')} onPress={stopCompare} />
            : <Btn primary label={tr('compare.run')} disabled={!prompt.trim()} onPress={start} />}
          {!busy && !!run && <Btn label={tr('compare.clear')} onPress={() => { clearCompareRun(); setViewing(null); }} />}
          {busy && <ActivityIndicator color={t.accentInk} />}
        </View>

        {panel && (
          <View style={{ marginTop: 18 }}>
            <View style={styles.resHead}>
              <Text style={{ color: t.text, fontSize: 16, fontWeight: '700', flex: 1 }}>{viewing ? tr('compare.savedTitle') : tr('compare.resultsTitle')}</Text>
              {!!viewing && <Btn small label={tr('compare.closeSaved')} onPress={() => setViewing(null)} />}
            </View>
            <Text numberOfLines={3} style={{ color: t.sub, fontSize: 12, marginTop: 4 }}>
              {panel.prompt}
            </Text>
            {!wide && panel.cols.length > 1 && (
              <View style={{ marginTop: 10 }}>
                <Segmented<string>
                  options={panel.targets.map((tg, i) => ({ value: String(i), label: labelOf(tg) }))}
                  value={String(idx)}
                  onChange={(v) => setTab(Number(v))}
                />
              </View>
            )}
            <View style={[wide ? styles.cols : null, { marginTop: 10 }]}>
              {(wide ? panel.cols.map((_, i) => i) : [idx]).map((i) => (
                <CompareColumn
                  key={i}
                  index={i}
                  label={labelOf(panel.targets[i])}
                  col={panel.cols[i]}
                  best={best!}
                  flex={wide}
                />
              ))}
            </View>
          </View>
        )}
        {opening && <ActivityIndicator color={t.accentInk} style={{ marginTop: 10 }} />}

        <View style={{ marginTop: 26 }}>
          <View style={styles.resHead}>
            <Text style={{ color: t.text, fontSize: 16, fontWeight: '700', flex: 1 }}>{tr('compare.past')}</Text>
            <Btn small label={tr('common.refresh')} onPress={loadPast} />
          </View>
          {!!pastErr && !unavailable && <Hint danger>{pastErr}</Hint>}
          {past && past.length === 0 && !pastErr && <Hint>{tr('compare.none')}</Hint>}
          {(past || []).map((row) => (
            <View key={row.id} style={[styles.pastRow, { borderRadius: th.r(10) }, { borderColor: t.border, backgroundColor: t.panel }]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1} style={{ color: t.text, fontWeight: '600' }}>{row.prompt || tr('compare.emptyPrompt')}</Text>
                <Text numberOfLines={1} style={{ color: t.sub, fontSize: 12, marginTop: 2 }}>
                  {fmtDate(row.createdAt)} · {row.targets.map(labelOf).join(', ')}
                </Text>
              </View>
              <Pressable onPress={() => open(row.id)} accessibilityRole="button" accessibilityLabel={tr('compare.openA11y')} hitSlop={6}>
                <Text style={{ color: t.accentInk, fontWeight: '600' }}>{tr('compare.open')}</Text>
              </Pressable>
              <Pressable onPress={() => remove(row)} accessibilityRole="button" accessibilityLabel={tr('compare.deleteA11y')} hitSlop={6}>
                <Text style={{ color: t.danger, fontWeight: '600' }}>{tr('common.delete')}</Text>
              </Pressable>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { padding: 16, width: '100%', maxWidth: 1200, alignSelf: 'center', paddingBottom: 40 },
  targetRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' },
  resHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cols: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, ...(Platform.OS === 'web' ? ({ flexWrap: 'nowrap' } as any) : {}) },
  pastRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, padding: 10, marginTop: 8 },
});
