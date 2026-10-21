import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { api } from '../api';
import type { Effort } from '../protocol';
import { applyUpsert, useStore } from '../store';
import { useTheme } from '../theme';
import { useT } from '../i18n';
import { Btn, Hint, Label, useDevMode } from '../ui/kit';
import { toast } from '../ui/toast';
import EffortPicker from './EffortPicker';
import ParamsEditor, { draftToParams, paramsToDraft } from './ParamsEditor';
import type { ParamsDraft } from './ParamsEditor';
import PromptEditor from './PromptEditor';

/** Global system prompt, effort, (dev) sampling params and the developer-mode switch. Only rendered on a v3 server. */
export default function GlobalDefaults() {
  const t = useTheme();
  const tr = useT();
  const settings = useStore((s) => s.settings);
  const dev = useDevMode();
  const [prompt, setPrompt] = useState('');
  const [effort, setEffort] = useState<Effort | null>(null);
  const [params, setParams] = useState<ParamsDraft>(paramsToDraft(null));
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // load drafts from the synced doc once it arrives, then only on explicit save
  useEffect(() => {
    if (loaded && settings) return;
    setPrompt(settings?.systemPrompt || '');
    setEffort(settings?.effort || null);
    setParams(paramsToDraft(settings?.params));
    if (settings) setLoaded(true);
  }, [settings, loaded]);

  const save = async () => {
    setBusy(true);
    try {
      const body: any = { systemPrompt: prompt.trim() ? prompt : null, effort };
      if (dev) body.params = draftToParams(params);
      applyUpsert({ settings: await api.putSettings(body) });
      toast(tr('set.saved'), 'ok');
    } catch (e: any) { toast(e.message || tr('set.saveFailed'), 'error'); } finally { setBusy(false); }
  };

  return (
    <View>
      <Text style={{ color: t.text, fontSize: 16, fontWeight: '700', marginTop: 24 }}>{tr('set.defaultsTitle')}</Text>
      <PromptEditor label={tr('set.globalPrompt')} value={prompt} onChange={setPrompt} hint={tr('set.globalPromptHint')} />
      <Label>{tr('effort.title')}</Label>
      <EffortPicker value={effort} onChange={setEffort} />
      <Hint>{tr('set.globalEffortHint')}</Hint>
      {dev && <View style={{ marginTop: 6 }}><ParamsEditor value={params} onChange={setParams} inheritFrom={tr('set.fromDefaults')} /></View>}
      <View style={{ marginTop: 12 }}><Btn primary label={busy ? tr('set.saving') : tr('set.saveDefaults')} disabled={busy} onPress={save} /></View>
    </View>
  );
}
