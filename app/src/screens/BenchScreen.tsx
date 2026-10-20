import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { apiDev } from '../apiDev';
import BenchRunDialog from '../components/BenchRunDialog';
import { useBenchProgress } from '../devState';
import type { BenchRun, BenchSet } from '../protocol';
import { useTheme, useThemeDef } from '../theme';
import { useT } from '../i18n';
import { fmtDate as fmtDateTime } from '../historyTypes';
import { confirmDialog } from '../ui/confirm';
import { Btn, Hint, ScreenHeader } from '../ui/kit';
import { toast } from '../ui/toast';
import BenchResults, { isActive } from './BenchResults';
import BenchSetEditor from './BenchSetEditor';

type Sub = { kind: 'home' } | { kind: 'set'; set: BenchSet | null } | { kind: 'results'; runId: string };

const fmtDate = (ts?: number | null) => (ts ? fmtDateTime(ts) : '-');

/** Developer-mode benchmarks: prompt sets, run history with live progress, and results pages. */
export default function BenchScreen({ onBack }: { onBack: () => void }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const [sub, setSub] = useState<Sub>({ kind: 'home' });
  const [sets, setSets] = useState<BenchSet[] | null>(null);
  const [runs, setRuns] = useState<BenchRun[] | null>(null);
  const [err, setErr] = useState('');
  const [dlg, setDlg] = useState(false);
  const prog = useBenchProgress();
  const doneKey = Object.entries(prog).filter(([, p]) => p.status).map(([k]) => k).join(',');

  const loadAll = useCallback(async () => {
    const [s, r] = await Promise.allSettled([apiDev.benchSets(), apiDev.benchRuns()]);
    if (s.status === 'fulfilled') setSets(s.value); else setSets([]);
    if (r.status === 'fulfilled') setRuns(r.value); else setRuns([]);
    const e = [s, r].find((x) => x.status === 'rejected') as PromiseRejectedResult | undefined;
    setErr(e ? (e.reason?.message || tr('bench.loadFailed')) : '');
  }, [tr]);
  useEffect(() => { loadAll(); }, [loadAll, doneKey]);

  if (sub.kind === 'set') return <BenchSetEditor initial={sub.set} onBack={() => setSub({ kind: 'home' })} onSaved={() => { setSub({ kind: 'home' }); loadAll(); }} />;
  if (sub.kind === 'results') return <BenchResults runId={sub.runId} onBack={() => { setSub({ kind: 'home' }); loadAll(); }} onDeleted={() => { setSub({ kind: 'home' }); loadAll(); }} />;

  // a run is live until its bench_done arrived (progress status set) or the list says otherwise
  const liveOf = (r: BenchRun) => !prog[r.id]?.status && isActive(r.status);
  const active = (runs || []).filter(liveOf);
  const delRun = async (r: BenchRun) => {
    if (!(await confirmDialog(tr('bench.deleteRunTitle'), tr('bench.deleteRunBody'), tr('common.delete')))) return;
    try { await apiDev.deleteBench(r.id); setRuns((x) => (x || []).filter((y) => y.id !== r.id)); }
    catch (e: any) { toast(e?.message || tr('bench.deleteFailed'), 'error'); }
  };
  const cancel = async (r: BenchRun) => {
    try { await apiDev.cancelBench(r.id); toast(tr('bench.cancelling'), 'info'); }
    catch (e: any) { toast(e?.message || tr('bench.cancelFailed'), 'error'); }
  };

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <ScreenHeader title={tr('dev.bench')} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.body}>
        {!!err && <Hint danger>{err}</Hint>}

        <Text style={[styles.h, { color: t.text }]}>{tr('bench.run')}</Text>
        <Text style={{ color: t.sub, fontSize: 13, lineHeight: 19 }}>
          {tr('bench.runDesc')}
        </Text>
        <Btn primary label={tr('bench.newRun')} disabled={!sets?.length} onPress={() => setDlg(true)} style={{ marginTop: 10 }} />
        {sets && sets.length === 0 && <Hint>{tr('bench.createSetFirst')}</Hint>}

        <Text style={[styles.h, { color: t.text, marginTop: 22 }]}>{tr('bench.sets')}</Text>
        <Btn small label={tr('bench.newSet')} onPress={() => setSub({ kind: 'set', set: null })} />
        {(sets || []).map((s) => (
          <Pressable key={s.id} onPress={() => setSub({ kind: 'set', set: s })} accessibilityRole="button" style={[styles.card, { borderRadius: th.r(10) }, { borderColor: t.border, backgroundColor: t.panel }]}>
            <Text style={{ color: t.text, fontWeight: '600' }}>{s.name}</Text>
            <Text style={{ color: t.sub, fontSize: 12, marginTop: 2 }}>{`${s.prompts.length === 1 ? tr('bench.promptsOne') : tr('bench.promptsMany', { n: s.prompts.length })}${s.systemPrompt ? tr('bench.withSystem') : ''}${tr('bench.tapToEdit')}`}</Text>
          </Pressable>
        ))}

        <Text style={[styles.h, { color: t.text, marginTop: 22 }]}>{tr('bench.runs')}</Text>
        {runs && runs.length === 0 && <Hint>{tr('bench.noRuns')}</Hint>}
        {(runs || []).map((r) => {
          const p = prog[r.id];
          const live = liveOf(r);
          const done = p?.done ?? r.done ?? 0;
          const total = p?.total ?? r.total ?? 0;
          return (
            <View key={r.id} style={[styles.card, { borderRadius: th.r(10) }, { borderColor: t.border, backgroundColor: t.panel }]}>
              <Pressable onPress={() => setSub({ kind: 'results', runId: r.id })} accessibilityRole="button" accessibilityLabel={tr('bench.openRun')}>
                <Text style={{ color: t.text, fontWeight: '600' }}>{r.setName || tr('bench.defaultName')}</Text>
                <Text style={{ color: live ? t.accentInk : t.sub, fontSize: 12, marginTop: 2 }}>
                  {live ? `${p?.status ? tr('bench.finishing') : r.status} ${done}/${total}` : (p?.status || r.status)} · {fmtDate(r.startedAt)}
                </Text>
                {live && !!p?.current && <Text numberOfLines={1} style={{ color: t.sub, fontSize: 11, marginTop: 2 }}>{p.current}</Text>}
              </Pressable>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                {live && <Btn small label={tr('common.cancel')} onPress={() => cancel(r)} />}
                {!live && <Btn small label={tr('bench.open')} onPress={() => setSub({ kind: 'results', runId: r.id })} />}
                {!live && <Btn small danger label={tr('common.delete')} onPress={() => delRun(r)} />}
              </View>
            </View>
          );
        })}
        {active.length > 0 && <Hint>{tr('bench.activeHint')}</Hint>}
      </ScrollView>
      <BenchRunDialog
        visible={dlg}
        sets={sets || []}
        onClose={() => setDlg(false)}
        onStarted={(runId) => { setDlg(false); setSub({ kind: 'results', runId }); loadAll(); }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { padding: 16, width: '100%', maxWidth: 760, alignSelf: 'center', paddingBottom: 40 },
  h: { fontSize: 16, fontWeight: '700', marginBottom: 6 },
  card: { borderWidth: 1, padding: 12, marginTop: 8 },
});
