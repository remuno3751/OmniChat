import React, { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { api } from '../api';
import ModelPicker from '../ModelPicker';
import type { ModelSel } from '../store';
import { activeProviders, applyUpsert, patchSettingsLocal, useStore } from '../store';
import type { SearchGuard, SearchOptions, SearchVisionModel } from '../protocol';
import { useT } from '../i18n';
import { useTheme } from '../theme';
import { Btn, Check, Field, Hint, Label, Segmented } from '../ui/kit';
import { toast } from '../ui/toast';
import { formatDomainList, parseDomainList, resolveSearchOptions } from '../searchOptions';

const splitKey = (k: string): ModelSel => { const i = k.indexOf('::'); return { providerId: k.slice(0, i), model: k.slice(i + 2) }; };
const joinKey = (s: ModelSel, fallbackModel?: string | null) => `${s.providerId}::${s.model ?? fallbackModel ?? ''}`;

/** Settings > Tools > "Search options": search model, limits, domain lists, page/image reading, guard and private URLs. */
export default function SearchSettingsSection() {
  const t = useTheme();
  const tr = useT();
  const settings = useStore((s) => s.settings);
  const providersMap = useStore((s) => s.providers);
  const providers = useMemo(() => activeProviders(providersMap), [providersMap]);
  const so = resolveSearchOptions(settings?.search);
  const searchSel = so.searchModel ? splitKey(so.searchModel) : null;
  const searchProv = providers.find((p) => p.id === searchSel?.providerId);

  const [allowText, setAllowText] = useState(formatDomainList(so.allowDomains));
  const [denyText, setDenyText] = useState(formatDomainList(so.denyDomains));
  // keep the text fields in step with the saved value (e.g. after a sync)
  useEffect(() => { setAllowText(formatDomainList(so.allowDomains)); }, [so.allowDomains.join('\n')]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setDenyText(formatDomainList(so.denyDomains)); }, [so.denyDomains.join('\n')]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!settings || settings.search === undefined) return null; // old server

  /** Optimistic local update, then PUT the partial object; roll back on failure. */
  const save = async (partial: Partial<SearchOptions>) => {
    const old = settings.search;
    patchSettingsLocal({ search: { ...so, ...partial } });
    try {
      applyUpsert({ settings: await api.putSettings({ search: partial }) });
    } catch (e: any) {
      patchSettingsLocal({ search: old });
      toast(e.message || tr('code.saveFailed'), 'error');
    }
  };

  const setSearchModel = (sel: ModelSel | null) => {
    const prov = providers.find((p) => p.id === sel?.providerId);
    save({ searchModel: sel ? joinKey(sel, prov?.model) : null });
  };
  const stepInt = (key: 'maxSites' | 'maxSearches' | 'maxImages', delta: number, min: number, max: number) => {
    const v = Math.min(max, Math.max(min, so[key] + delta));
    if (v !== so[key]) save({ [key]: v } as Partial<SearchOptions>);
  };
  const domainsDirty = parseDomainList(allowText).join('\n') !== so.allowDomains.join('\n')
    || parseDomainList(denyText).join('\n') !== so.denyDomains.join('\n');
  const saveDomains = () => save({ allowDomains: parseDomainList(allowText), denyDomains: parseDomainList(denyText) });

  const stepper = (label: string, hint: string, key: 'maxSites' | 'maxSearches' | 'maxImages', min: number, max: number) => (
    <View style={{ marginTop: 12 }}>
      <Label>{label}</Label>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Btn small label="−" disabled={so[key] <= min} onPress={() => stepInt(key, -1, min, max)} />
        <Text style={{ color: t.text, fontSize: 14, minWidth: 64, textAlign: 'center' }}>{so[key]}</Text>
        <Btn small label="+" disabled={so[key] >= max} onPress={() => stepInt(key, 1, min, max)} />
      </View>
      <Hint>{hint}</Hint>
    </View>
  );

  return (
    <View>
      <Text style={{ color: t.text, fontSize: 16, fontWeight: '700', marginTop: 22 }}>{tr('search.opts.title')}</Text>

      <Label>{tr('search.opts.model')}</Label>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <ModelPicker sel={searchSel} providerName={searchProv?.name || ''} fallbackModel={undefined} hasProviders={providers.length > 0} onSelect={setSearchModel} onAddProvider={() => {}} />
        {!!searchSel && <Btn small label={tr('search.opts.useAnswerModel')} onPress={() => setSearchModel(null)} />}
      </View>
      <Hint>{searchSel ? tr('search.opts.modelSet') : tr('search.opts.modelUnset')}</Hint>
      <Hint>{tr('search.opts.gpuHint')}</Hint>

      {stepper(tr('search.opts.maxSites'), tr('search.opts.maxSitesHint'), 'maxSites', 1, 30)}
      {stepper(tr('search.opts.maxSearches'), tr('search.opts.maxSearchesHint'), 'maxSearches', 1, 10)}

      <View style={{ marginTop: 12 }}>
        <Field label={tr('search.opts.allowDomains')} value={allowText} onChangeText={setAllowText} multiline minHeight={70} mono placeholder={tr('search.opts.domainsPlaceholder')} />
        <Hint>{tr('search.opts.allowHint')}</Hint>
      </View>
      <View style={{ marginTop: 10 }}>
        <Field label={tr('search.opts.denyDomains')} value={denyText} onChangeText={setDenyText} multiline minHeight={70} mono placeholder={tr('search.opts.domainsPlaceholder')} />
        <Hint>{tr('search.opts.denyHint')}</Hint>
      </View>
      {domainsDirty && <View style={{ marginTop: 8 }}><Btn small primary label={tr('search.opts.saveDomains')} onPress={saveDomains} /></View>}

      <View style={{ marginTop: 14 }}>
        <Check label={tr('search.opts.readPages')} value={so.readPages} onChange={(v) => save({ readPages: v })} hint={tr('search.opts.readPagesHint')} />
      </View>
      <View style={{ marginTop: 10 }}>
        <Check label={tr('search.opts.readImages')} value={so.readImages} onChange={(v) => save({ readImages: v })} hint={tr('search.opts.readImagesHint')} />
      </View>
      {so.readImages && (
        <View style={{ marginTop: 8, paddingLeft: 12 }}>
          {stepper(tr('search.opts.maxImages'), tr('search.opts.maxImagesHint'), 'maxImages', 1, 10)}
          <Label>{tr('search.opts.visionModel')}</Label>
          <Segmented<SearchVisionModel>
            options={[{ value: 'answer', label: tr('search.opts.visionAnswer') }, { value: 'search', label: tr('search.opts.visionSearch') }]}
            value={so.visionModel}
            onChange={(v) => save({ visionModel: v })}
          />
          <Hint>{tr('search.opts.visionHint')}</Hint>
        </View>
      )}

      <Label>{tr('search.opts.guard')}</Label>
      <Segmented<SearchGuard>
        options={[{ value: 'off', label: tr('search.opts.guardOff') }, { value: 'standard', label: tr('search.opts.guardStandard') }, { value: 'strict', label: tr('search.opts.guardStrict') }]}
        value={so.guard}
        onChange={(v) => save({ guard: v })}
      />
      <Hint>{tr('search.opts.guardHint')}</Hint>

      <View style={{ marginTop: 14 }}>
        <Check label={tr('search.opts.allowPrivate')} value={so.allowPrivateUrls} onChange={(v) => save({ allowPrivateUrls: v })} hint={tr('search.opts.allowPrivateHint')} />
        {so.allowPrivateUrls && <Hint danger>{tr('search.opts.allowPrivateWarn')}</Hint>}
      </View>
    </View>
  );
}
