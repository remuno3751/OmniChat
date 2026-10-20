import React, { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { api } from '../api';
import ModelPicker, { useModelGroups } from '../ModelPicker';
import ToolsScreen from '../screens/ToolsScreen';
import { activeProviders, applyUpsert, patchSettingsLocal, useStore } from '../store';
import type { ModelSel } from '../store';
import { useT } from '../i18n';
import { useTools } from '../toolState';
import { useTheme } from '../theme';
import { Btn, Check, Hint, Label, useDevMode } from '../ui/kit';
import { toast } from '../ui/toast';
import ParamsEditor, { draftToParams, paramsToDraft } from './ParamsEditor';
import type { ParamsDraft } from './ParamsEditor';

export type P3Sub = 'tools';

/** Full-screen sub page of Settings (used like the other sub screens). */
export function P3SubScreen({ sub, onBack }: { sub: P3Sub; onBack: () => void }) {
  return sub === 'tools' ? <ToolsScreen onBack={onBack} /> : null;
}

const splitKey = (k: string): ModelSel => { const i = k.indexOf('::'); return { providerId: k.slice(0, i), model: k.slice(i + 2) }; };
const joinKey = (s: ModelSel) => `${s.providerId}::${s.model ?? ''}`;

/** Settings entries of phase 3: Tools screen link, auto title (+title model), per-model generation parameters (developer mode). */
export function P3Entries({ onOpen }: { onOpen: (s: P3Sub) => void }) {
  const t = useTheme();
  const tr = useT();
  const settings = useStore((s) => s.settings);
  const providersMap = useStore((s) => s.providers);
  const providers = useMemo(() => activeProviders(providersMap), [providersMap]);
  const dev = useDevMode();
  const tools = useTools();
  const { groups } = useModelGroups();
  const [mp, setMp] = useState<ModelSel | null>(null);
  const [draft, setDraft] = useState<ParamsDraft>(paramsToDraft(null));
  const hasTools = !!tools.value;
  const hasTitle = settings?.autoTitle !== undefined;
  const hasParams = dev && settings !== null && settings.modelParams !== undefined;
  const modelParams = settings?.modelParams || {};

  const put = async (body: any, rollback: () => void) => {
    try { applyUpsert({ settings: await api.putSettings(body) }); } catch (e: any) { rollback(); toast(e.message || tr('code.saveFailed'), 'error'); }
  };
  const setAuto = (v: boolean) => { const old = settings?.autoTitle; patchSettingsLocal({ autoTitle: v }); put({ autoTitle: v }, () => patchSettingsLocal({ autoTitle: old })); };
  const titleOn = settings?.autoTitle !== false;
  const titleEvery = settings?.titleEvery ?? 6;
  const setEvery = (n: number) => {
    const v = Math.min(50, Math.max(0, Math.round(n)));
    if (v === titleEvery) return;
    const old = settings?.titleEvery;
    patchSettingsLocal({ titleEvery: v });
    put({ titleEvery: v }, () => patchSettingsLocal({ titleEvery: old }));
  };
  const setTitleModel = (sel: ModelSel | null) => {
    const old = settings?.titleModel ?? null;
    const v = sel ? joinKey({ providerId: sel.providerId, model: sel.model ?? providers.find((p) => p.id === sel.providerId)?.model ?? '' }) : null;
    patchSettingsLocal({ titleModel: v });
    put({ titleModel: v }, () => patchSettingsLocal({ titleModel: old }));
  };
  const saveParams = (key: string, p: ReturnType<typeof draftToParams>) => {
    const old = settings?.modelParams ?? null;
    const next = { ...modelParams };
    if (p) next[key] = p; else delete next[key];
    const val = Object.keys(next).length ? next : null;
    patchSettingsLocal({ modelParams: val });
    put({ modelParams: val }, () => patchSettingsLocal({ modelParams: old }));
  };

  if (!hasTools && !hasTitle && !hasParams) return null;
  const titleSel = settings?.titleModel ? splitKey(settings.titleModel) : null;
  const titleProv = providers.find((p) => p.id === titleSel?.providerId);
  const mpKey = mp ? joinKey({ providerId: mp.providerId, model: mp.model ?? providers.find((p) => p.id === mp.providerId)?.model ?? '' }) : '';
  const mpProv = providers.find((p) => p.id === mp?.providerId);
  const pickMp = (s: ModelSel) => {
    setMp(s);
    const k = joinKey({ providerId: s.providerId, model: s.model ?? providers.find((p) => p.id === s.providerId)?.model ?? '' });
    setDraft(paramsToDraft(modelParams[k]));
  };

  return (
    <View>
      {hasTools && (
        <>
          <Text style={{ color: t.text, fontSize: 16, fontWeight: '700', marginTop: 24 }}>{tr('tools.title')}</Text>
          <Hint>{tr('tools.entryHint')}</Hint>
          <View style={{ marginTop: 8 }}><Btn label={tr('tools.entryBtn')} onPress={() => onOpen('tools')} /></View>
        </>
      )}
      {hasTitle && (
        <>
          <Text style={{ color: t.text, fontSize: 16, fontWeight: '700', marginTop: 24 }}>{tr('tools.titlesTitle')}</Text>
          <Check label={tr('tools.autoTitle')} value={settings?.autoTitle !== false} onChange={setAuto} hint={tr('tools.autoTitleHint')} />
          {settings?.titleEvery !== undefined && (
            <View style={{ marginTop: 12, opacity: titleOn ? 1 : 0.45 }}>
              <Label>{tr('settings.titleEvery')}</Label>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Btn small label="−" disabled={!titleOn || titleEvery <= 0} onPress={() => setEvery(titleEvery - 1)} />
                <Text style={{ color: t.text, fontSize: 14, minWidth: 64, textAlign: 'center', flexShrink: 1 }}>
                  {titleEvery === 0 ? tr('settings.titleEvery.never') : `${titleEvery} ${tr('settings.titleEvery.unit')}`}
                </Text>
                <Btn small label="+" disabled={!titleOn || titleEvery >= 50} onPress={() => setEvery(titleEvery + 1)} />
              </View>
              <Hint>{tr('settings.titleEvery.hint')}</Hint>
            </View>
          )}
          {settings?.autoTitle !== false && (
            <>
              <Label>{tr('tools.titleModel')}</Label>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <ModelPicker sel={titleSel} providerName={titleProv?.name || ''} fallbackModel={undefined} hasProviders={providers.length > 0} onSelect={setTitleModel} onAddProvider={() => {}} />
                {!!titleSel && <Btn small label={tr('tools.clear')} onPress={() => setTitleModel(null)} />}
              </View>
              <Hint>{titleSel ? tr('tools.titleModelSet') : tr('tools.titleModelUnset')}</Hint>
            </>
          )}
        </>
      )}
      {hasParams && (
        <>
          <Text style={{ color: t.text, fontSize: 16, fontWeight: '700', marginTop: 24 }}>{tr('tools.paramsTitle')}</Text>
          <Hint>{tr('tools.paramsHint')}</Hint>
          {Object.keys(modelParams).length === 0 && <Hint>{tr('tools.paramsEmpty')}</Hint>}
          {Object.entries(modelParams).map(([k, p]) => {
            const s = splitKey(k);
            const pn = groups?.find((g) => g.providerId === s.providerId)?.providerName || providers.find((x) => x.id === s.providerId)?.name || s.providerId;
            const summary = Object.entries(p || {}).filter(([, v]) => v !== null && v !== undefined).map(([a, v]) => `${a} ${Array.isArray(v) ? tr('tools.stopSeqs', { n: v.length }) : v}`).join(' · ');
            return (
              <View key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={{ color: t.text, fontSize: 13 }}>{s.model} <Text style={{ color: t.sub }}>({pn})</Text></Text>
                  <Text numberOfLines={1} style={{ color: t.sub, fontSize: 11 }}>{summary || tr('tools.allInherit')}</Text>
                </View>
                <Btn small label={tr('common.edit')} onPress={() => { setMp(s); setDraft(paramsToDraft(p)); }} />
                <Btn small danger label={tr('tools.remove')} onPress={() => { saveParams(k, null); if (mpKey === k) setMp(null); }} />
              </View>
            );
          })}
          <Label>{tr('tools.pickModel')}</Label>
          <ModelPicker sel={mp} providerName={mpProv?.name || ''} fallbackModel={mpProv?.model} hasProviders={providers.length > 0} onSelect={pickMp} onAddProvider={() => {}} />
          {!!mp && (
            <View style={{ marginTop: 6 }}>
              <Text style={{ color: t.text, fontSize: 13, fontWeight: '600' }}>{mp.model ?? mpProv?.model} <Text style={{ color: t.sub, fontWeight: '400' }}>({mpProv?.name})</Text></Text>
              <ParamsEditor value={draft} onChange={setDraft} inheritFrom={tr('tools.inheritGlobal')} />
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                <Btn primary small label={tr('tools.saveModel')} onPress={() => { saveParams(mpKey, draftToParams(draft)); toast(tr('tools.saved'), 'ok'); }} />
                <Btn small label={tr('common.close')} onPress={() => setMp(null)} />
              </View>
            </View>
          )}
        </>
      )}
    </View>
  );
}
