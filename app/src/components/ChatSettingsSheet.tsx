import React, { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import type { Effort, SearchMode, SystemMode } from '../protocol';
import { activeProviders, applyUpsert, useStore } from '../store';
import { selectedModelInfo, useModelGroups } from '../ModelPicker';
import { Btn, Hint, Label, useDevMode } from '../ui/kit';
import { toast } from '../ui/toast';
import { useT } from '../i18n';
import EffortPicker from './EffortPicker';
import ParamsEditor, { draftToParams, paramsToDraft } from './ParamsEditor';
import type { ParamsDraft } from './ParamsEditor';
import PromptEditor from './PromptEditor';
import { ToolSearchFields } from './ToolPickers';
import { useSearchStatus, useTools } from '../toolState';
import ResponseFormatEditor, { draftToRF, emptyRF, rfToDraft } from './ResponseFormatEditor';
import type { RFDraft } from './ResponseFormatEditor';
import { useDevAvail } from '../devState';
import OverflowSlider from './OverflowSlider';
import type { ChatOverflow } from '../overflowSteps';

/** Per-conversation settings (system prompt, effort, tools, search, dev params). Rendered inline in Settings > This chat. */
export function ChatSettingsBody({ convId }: { convId: string }) {
  const t = useT();
  const conv = useStore((s) => s.conversations[convId]);
  const exists = !!conv;
  const dev = useDevMode();
  const providersMap = useStore((s) => s.providers);
  const providers = useMemo(() => activeProviders(providersMap), [providersMap]);
  const { groups } = useModelGroups();
  const provider = providers.find((p) => p.id === conv?.providerId) || null;
  const effortUnsupported = !!conv && selectedModelInfo(groups, conv.providerId ? { providerId: conv.providerId, model: conv.model } : null, provider?.model)?.effort === 'unsupported';

  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<SystemMode>('append');
  const [effort, setEffort] = useState<Effort | null>(null);
  const [params, setParams] = useState<ParamsDraft>(paramsToDraft(null));
  const [busy, setBusy] = useState(false);
  const [tools, setTools] = useState<string[] | null>(null);
  const [search, setSearch] = useState<SearchMode | null>(null);
  const [ctxOv, setCtxOv] = useState<ChatOverflow>(null);
  const hasCtx = useStore((s) => s.settings?.contextOverflow !== undefined);
  const [rf, setRf] = useState<RFDraft>(emptyRF());
  const rfOk = useDevAvail('any');
  const hasTools = !!useTools().value;
  const hasSearch = !!useSearchStatus().value;

  // Load from the conversation when the chat changes or first appears (not on every store update, so edits are kept).
  useEffect(() => {
    if (!conv) return;
    setPrompt(conv.systemPrompt || '');
    setMode(conv.systemMode || 'append');
    setEffort(conv.effort || null);
    setParams(paramsToDraft(conv.params));
    setTools(conv.tools ?? null);
    setSearch(conv.searchMode ?? null);
    setCtxOv(conv.contextOverflow ?? null);
    setRf(rfToDraft(conv.responseFormat));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId, exists]);

  if (!conv) return <Hint>{t('settings.thisChat.disabled')}</Hint>;

  const save = async () => {
    const r = draftToRF(rf);
    if (dev && rfOk && r.error) { toast(r.error, 'error'); return; }
    setBusy(true);
    try {
      const body: any = { systemPrompt: prompt.trim() ? prompt : null, systemMode: mode, effort };
      if (dev) body.params = draftToParams(params);
      if (hasTools) body.tools = tools;
      if (hasSearch) body.searchMode = search;
      if (hasCtx) body.contextOverflow = ctxOv;
      if (dev && rfOk) body.responseFormat = r.value;
      applyUpsert({ conversations: [await api.putConversation(convId, body)] });
      toast(t('set.saved'), 'ok');
    } catch (e: any) { toast(e.message || t('set.saveFailed'), 'error'); } finally { setBusy(false); }
  };

  return (
    <View style={{ gap: 12 }}>
      <PromptEditor label={t('set.chatPrompt')} value={prompt} onChange={setPrompt} mode={mode} onMode={setMode} hint={t('set.chatPromptHint')} />
      <Label>{t('set.chatEffort')}</Label>
      <EffortPicker value={effort} onChange={setEffort} disabled={effortUnsupported} />
      <Hint>{effortUnsupported ? t('set.effortUnsupported') : t('set.effortInherit')}</Hint>
      <ToolSearchFields tools={tools} onTools={setTools} search={search} onSearch={setSearch} inheritFrom={t('set.fromProjectGlobal')} />
      {hasCtx && <OverflowSlider label={t('set.ctx.whenFull')} value={ctxOv} onChange={setCtxOv} withDefault />}
      {dev && rfOk && <ResponseFormatEditor value={rf} onChange={setRf} hint={t('set.rfHint')} />}
      {dev && <ParamsEditor value={params} onChange={setParams} inheritFrom={t('set.fromProjectGlobal')} />}
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
        <Btn primary label={busy ? t('set.saving') : t('common.save')} disabled={busy} onPress={save} />
      </View>
    </View>
  );
}
