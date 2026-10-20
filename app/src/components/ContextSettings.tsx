import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { api } from '../api';
import { limitKey } from '../contextState';
import { useDevice } from '../deviceSettings';
import { resolveLanguage, useT } from '../i18n';
import { useModelGroups } from '../ModelPicker';
import type { ContextOverflow, Settings } from '../protocol';
import { applyUpsert, patchSettingsLocal, useStore } from '../store';
import { useTheme } from '../theme';
import { Btn, Field, Hint, Label, Segmented, useDevMode } from '../ui/kit';
import OverflowSlider from './OverflowSlider';
import SliderField from '../ui/SliderField';
import { COMPRESS_AT_OFF, compressAtToSlider, sliderToCompressAt } from '../overflowSteps';
import { toast } from '../ui/toast';

type NumKey = 'defaultContextLength' | 'contextCompressAt' | 'contextCompressTarget';

/** One whole-number setting: draft text, Save when changed. Empty = null when `nullable`. */
function NumSetting({ label, help, value, placeholder, min, max, nullable, onSave }: {
  label: string; help: string; value: number | null | undefined; placeholder: string; min: number; max: number; nullable?: boolean;
  onSave: (v: number | null) => void;
}) {
  const tr = useT();
  const shown = value == null ? '' : String(value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const dirty = draft.trim() !== shown;
  const save = () => {
    const s = draft.trim();
    if (s === '') {
      if (!nullable) { toast(tr('set.ctx.rangeAny', { min, max }), 'error'); return; }
      onSave(null);
      return;
    }
    const n = Number(s);
    if (!/^\d+$/.test(s) || n < min || n > max) { toast(tr('set.ctx.rangeWhole', { min, max }), 'error'); return; }
    onSave(n);
  };
  return (
    <View style={{ marginTop: 12 }}>
      <Label>{label}</Label>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Field value={draft} onChangeText={setDraft} keyboardType="numeric" placeholder={placeholder} onSubmit={save} />
        </View>
        <Btn small primary label={tr('common.save')} disabled={!dirty} onPress={save} />
      </View>
      <Hint>{help}</Hint>
    </View>
  );
}

/** Slider that follows the finger locally and saves once the value has settled (no request per pixel). */
function DebouncedSlider({ value, onCommit, ...rest }: { value: number; min: number; max: number; step: number; label: string; format: (v: number) => string; onCommit: (v: number) => void }) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  useEffect(() => {
    if (local === value) return;
    const id = setTimeout(() => onCommit(local), 500);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local]);
  return <SliderField {...rest} value={local} onChange={setLocal} />;
}

/** Settings: 'When the context is full' + (dev mode) per-model context limit overrides. Only for servers that know the settings (v3 phase 2). */
export default function ContextSettings() {
  const t = useTheme();
  const tr = useT();
  const lang = resolveLanguage(useDevice((s) => s.language));
  const settings = useStore((s) => s.settings);
  const dev = useDevMode();
  const { groups } = useModelGroups();
  const mode: ContextOverflow = settings?.contextOverflow || 'summarize';
  const limits = settings?.contextLimits || {};
  const [pid, setPid] = useState('');
  const [model, setModel] = useState('');
  const [val, setVal] = useState('');
  const help: Record<ContextOverflow, string> = {
    truncate: tr('set.ctx.helpTruncate'),
    summarize: tr('set.ctx.helpSummarize'),
    stop: tr('set.ctx.helpStop'),
  };

  const put = async (body: { contextOverflow?: ContextOverflow; contextLimits?: Record<string, number> | null }, rollback: () => void) => {
    try { applyUpsert({ settings: await api.putSettings(body) }); } catch (e: any) { rollback(); toast(e.message || tr('set.saveFailed'), 'error'); }
  };
  const setMode = (m: ContextOverflow) => {
    const old = mode;
    patchSettingsLocal({ contextOverflow: m });
    put({ contextOverflow: m }, () => patchSettingsLocal({ contextOverflow: old }));
  };
  const saveNum = async (patch: Partial<Pick<Settings, NumKey>>) => {
    const old: Partial<Pick<Settings, NumKey>> = {};
    for (const k of Object.keys(patch) as NumKey[]) (old as Record<string, unknown>)[k] = settings?.[k];
    patchSettingsLocal(patch);
    try { applyUpsert({ settings: await api.putSettings(patch) }); } catch (e: any) { patchSettingsLocal(old); toast(e.message || tr('set.saveFailed'), 'error'); }
  };
  const saveLimits = (next: Record<string, number>) => {
    const old = settings?.contextLimits ?? null;
    patchSettingsLocal({ contextLimits: next });
    put({ contextLimits: Object.keys(next).length ? next : null }, () => patchSettingsLocal({ contextLimits: old }));
  };
  const provs = (groups || []).filter((g) => g.models.length);
  const cur = provs.find((g) => g.providerId === pid) || provs[0];
  const add = () => {
    const n = parseInt(val.replace(/[^0-9]/g, ''), 10);
    const m = model.trim();
    if (!cur || !m || !(n > 0)) { toast(tr('set.ctx.pickAll'), 'error'); return; }
    saveLimits({ ...limits, [limitKey(cur.providerId, m)]: n });
    setVal(''); setModel('');
  };

  return (
    <View>
      <Text style={{ color: t.text, fontSize: 16, fontWeight: '700', marginTop: 24 }}>{tr('set.ctx.whenFull')}</Text>
      <OverflowSlider label={tr('set.ctx.defaultBehavior')} value={mode} onChange={(v) => v && setMode(v)} />
      <NumSetting
        label={tr('set.ctx.defaultLength')}
        help={tr('set.ctx.defaultLengthHelp')}
        value={settings?.defaultContextLength}
        placeholder={tr('set.ctx.defaultLengthPh')}
        min={256}
        max={10000000}
        nullable
        onSave={(v) => saveNum({ defaultContextLength: v })}
      />
      {mode === 'summarize' && (
        <>
          <DebouncedSlider
            label={tr('set.ctx.compressAt')}
            value={compressAtToSlider(settings?.contextCompressAt)}
            min={50}
            max={COMPRESS_AT_OFF}
            step={5}
            format={(v) => (v >= COMPRESS_AT_OFF ? tr('set.ctx.compressOff') : v + '%')}
            onCommit={(v) => saveNum({ contextCompressAt: sliderToCompressAt(v) })}
          />
          <Hint>{tr('set.ctx.compressAtHelp')}</Hint>
          <DebouncedSlider
            label={tr('set.ctx.compressTarget')}
            value={settings?.contextCompressTarget ?? 50}
            min={20}
            max={80}
            step={5}
            format={(v) => v + '%'}
            onCommit={(v) => saveNum({ contextCompressTarget: v })}
          />
          <Hint>{tr('set.ctx.compressTargetHelp')}</Hint>
        </>
      )}
      {dev && (
        <View style={{ marginTop: 6 }}>
          <Label>{tr('set.ctx.overrides')}</Label>
          {Object.keys(limits).length === 0 && <Hint>{tr('set.ctx.noOverrides')}</Hint>}
          {Object.entries(limits).map(([k, v]) => {
            const [p, ...rest] = k.split('::');
            const pn = groups?.find((g) => g.providerId === p)?.providerName || p;
            return (
              <View key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 }}>
                <Text style={{ color: t.text, flex: 1, fontSize: 13 }} numberOfLines={2}>{rest.join('::')} <Text style={{ color: t.sub }}>({pn})</Text></Text>
                <Text style={{ color: t.text, fontSize: 13 }}>{v.toLocaleString(lang)}</Text>
                <Btn small label={tr('set.ctx.remove')} onPress={() => { const n = { ...limits }; delete n[k]; saveLimits(n); }} />
              </View>
            );
          })}
          {provs.length > 1 && (
            <Segmented<string> options={provs.map((g) => ({ value: g.providerId, label: g.providerName }))} value={cur?.providerId || ''} onChange={setPid} />
          )}
          <Field label={tr('set.ctx.modelId')} value={model} onChangeText={setModel} placeholder={cur?.models[0]?.id || tr('set.ctx.modelFallback')} />
          <Field label={tr('set.ctx.limitTokens')} value={val} onChangeText={setVal} keyboardType="numeric" placeholder={tr('set.ctx.limitPh')} />
          <View style={{ marginTop: 8 }}><Btn small primary label={tr('set.ctx.addOverride')} disabled={!model.trim() || !val.trim()} onPress={add} /></View>
        </View>
      )}
    </View>
  );
}
