import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { ApiError } from '../api';
import { apiDev } from '../apiDev';
import ModelPicker from '../ModelPicker';
import type { BenchSet, BenchTarget } from '../protocol';
import type { ModelSel } from '../store';
import { activeProviders, useStore } from '../store';
import { useTheme } from '../theme';
import { useT } from '../i18n';
import { Btn, Check, Field, Hint, Label, Segmented, Sheet } from '../ui/kit';
import { toast } from '../ui/toast';

const MAX_TARGETS = 6;

/** Run dialog: prompt set, 1-6 targets, repeats, max tokens, warm-up. Starts the run and hands its id back. */
export default function BenchRunDialog({ visible, sets, onClose, onStarted }: {
  visible: boolean; sets: BenchSet[]; onClose: () => void; onStarted: (runId: string) => void;
}) {
  const t = useTheme();
  const tr = useT();
  const providers = useStore((s) => s.providers);
  const lastSel = useStore((s) => s.lastSel);
  const hasProviders = activeProviders(providers).length > 0;
  const [setId, setSetId] = useState<string>('');
  const [targets, setTargets] = useState<(ModelSel | null)[]>([lastSel ?? null]);
  const [repeats, setRepeats] = useState('1');
  const [maxTokens, setMaxTokens] = useState('256');
  const [warmup, setWarmup] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const chosenSet = sets.find((s) => s.id === setId) || sets[0] || null;

  const start = async () => {
    setErr('');
    if (!chosenSet) { setErr(tr('bench.errNoSet')); return; }
    const chosen = targets.filter((s): s is ModelSel => !!s);
    if (!chosen.length) { setErr(tr('bench.errNoTarget')); return; }
    const rep = parseInt(repeats, 10);
    const mt = parseInt(maxTokens, 10);
    if (!(rep >= 1 && rep <= 5)) { setErr(tr('bench.errRepeats')); return; }
    if (!(mt >= 1 && mt <= 32768)) { setErr(tr('bench.errMaxTokens', { max: 32768 })); return; }
    const tg: BenchTarget[] = chosen.map((s) => ({ providerId: s.providerId, model: s.model || providers[s.providerId]?.model || '' }));
    setBusy(true);
    try {
      const r = await apiDev.startBench({ setId: chosenSet.id, targets: tg, repeats: rep, warmup, maxTokens: mt });
      toast(tr('bench.started'), 'ok');
      onStarted(r.runId);
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 409) setErr(tr('bench.busy'));
      else setErr(e?.message || tr('bench.startFailed'));
    }
    setBusy(false);
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={tr('bench.newRun')}
      width={600}
      footer={<><Btn primary label={busy ? tr('bench.starting') : tr('bench.startRun')} disabled={busy || !chosenSet} onPress={start} /><Btn label={tr('common.cancel')} onPress={onClose} /></>}
    >
      <Label>{tr('bench.promptSet')}</Label>
      {sets.length === 0
        ? <Hint danger>{tr('bench.noSets')}</Hint>
        : <Segmented<string> options={sets.map((s) => ({ value: s.id, label: `${s.name} (${s.prompts.length})` }))} value={chosenSet?.id ?? ''} onChange={setSetId} />}

      <Label>{tr('bench.targets', { max: MAX_TARGETS })}</Label>
      {targets.map((s, i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <ModelPicker
              sel={s}
              providerName={providers[s?.providerId ?? '']?.name ?? ''}
              fallbackModel={providers[s?.providerId ?? '']?.model}
              hasProviders={hasProviders}
              onSelect={(x) => setTargets((ts) => ts.map((y, k) => (k === i ? x : y)))}
              onAddProvider={() => toast(tr('bench.addProviderFirst'), 'info')}
            />
          </View>
          {targets.length > 1 && <Btn small label={tr('bench.remove')} onPress={() => setTargets((ts) => ts.filter((_, k) => k !== i))} />}
        </View>
      ))}
      {targets.length < MAX_TARGETS && <Btn small label={tr('bench.addTarget')} onPress={() => setTargets((ts) => [...ts, null])} style={{ marginTop: 6 }} />}

      <Label>{tr('bench.repeatsLabel')}</Label>
      <Segmented<string> options={['1', '2', '3', '4', '5'].map((v) => ({ value: v, label: v }))} value={repeats} onChange={setRepeats} />
      <Field label={tr('bench.maxTokens')} value={maxTokens} onChangeText={setMaxTokens} keyboardType="numeric" />
      <Check
        label={tr('bench.warmup')}
        value={warmup}
        onChange={setWarmup}
        hint={tr('bench.warmupHint')}
      />
      <Text style={{ color: t.sub, fontSize: 12, marginTop: 10, lineHeight: 17 }}>
        {tr('bench.runNote')}
      </Text>
      {!!err && <Hint danger>{err}</Hint>}
    </Sheet>
  );
}
