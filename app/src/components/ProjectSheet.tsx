import React, { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { api, uuid } from '../api';
import ModelPicker from '../ModelPicker';
import type { ChatMode, Effort, SystemMode } from '../protocol';
import { activeProviders, applyUpsert, useStore } from '../store';
import type { ModelSel } from '../store';
import { useT } from '../i18n';
import { confirmDialog } from '../ui/confirm';
import { Btn, Field, Hint, Label, Sheet, useDevMode } from '../ui/kit';
import { toast } from '../ui/toast';
import EffortPicker from './EffortPicker';
import ParamsEditor, { draftToParams, paramsToDraft } from './ParamsEditor';
import type { ParamsDraft } from './ParamsEditor';
import PromptEditor from './PromptEditor';
import { ToolSearchFields } from './ToolPickers';
import { useSearchStatus, useTools } from '../toolState';
import type { SearchMode } from '../protocol';
import ResponseFormatEditor, { draftToRF, emptyRF, rfToDraft } from './ResponseFormatEditor';
import type { RFDraft } from './ResponseFormatEditor';
import { useDevAvail } from '../devState';

/** Create (projectId null) or edit a project: name, system prompt + mode, default model, effort, params (dev mode). */
export default function ProjectSheet({ visible, projectId, onClose, onCreated, mode: chatMode = 'chat' }: {
  visible: boolean; projectId: string | null; onClose: () => void; onCreated?: (id: string) => void;
  /** chat / code of a project created here (ignored when editing) */
  mode?: ChatMode;
}) {
  const tr = useT();
  const project = useStore((s) => (projectId ? s.projects[projectId] : undefined));
  const providersMap = useStore((s) => s.providers);
  const providers = useMemo(() => activeProviders(providersMap), [providersMap]);
  const dev = useDevMode();
  const [newId, setNewId] = useState(() => uuid());
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<SystemMode>('append');
  const [sel, setSel] = useState<ModelSel | null>(null);
  const [effort, setEffort] = useState<Effort | null>(null);
  const [params, setParams] = useState<ParamsDraft>(paramsToDraft(null));
  const [busy, setBusy] = useState(false);
  const [tools, setTools] = useState<string[] | null>(null);
  const [search, setSearch] = useState<SearchMode | null>(null);
  const [rf, setRf] = useState<RFDraft>(emptyRF());
  const rfOk = useDevAvail('any');
  const hasTools = !!useTools().value;
  const hasSearch = !!useSearchStatus().value;
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!visible) return;
    setNewId(uuid());
    setName(project?.name || '');
    setPrompt(project?.systemPrompt || '');
    setMode(project?.systemMode || 'append');
    setSel(project?.defaultProviderId ? { providerId: project.defaultProviderId, model: project.defaultModel } : null);
    setEffort(project?.effort || null);
    setParams(paramsToDraft(project?.params));
    setTools(project?.tools ?? null);
    setSearch(project?.searchMode ?? null);
    setRf(rfToDraft(project?.responseFormat));
    setErr('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, projectId]);

  const provider = providers.find((p) => p.id === sel?.providerId);

  const save = async () => {
    if (busy) return;
    if (!name.trim()) { setErr(tr('proj.nameRequired')); return; }
    const r = draftToRF(rf);
    if (dev && rfOk && r.error) { setErr(r.error); return; }
    setBusy(true); setErr('');
    try {
      const id = projectId || newId;
      const body: any = {
        name: name.trim(), systemPrompt: prompt.trim() ? prompt : null, systemMode: mode,
        defaultProviderId: sel?.providerId ?? null, defaultModel: sel?.providerId ? sel.model : null, effort,
      };
      if (!projectId) body.mode = chatMode;
      if (hasTools) body.tools = tools;
      if (hasSearch) body.searchMode = search;
      if (dev && rfOk && (r.value || project?.responseFormat)) body.responseFormat = r.value;
      if (dev || project?.params) body.params = dev ? draftToParams(params) : project?.params ?? null;
      applyUpsert({ projects: [await api.putProject(id, body)] });
      if (!projectId) onCreated?.(id);
      onClose();
    } catch (e: any) { setErr(e.message || String(e)); } finally { setBusy(false); }
  };

  const del = async () => {
    if (!projectId) return;
    if (!(await confirmDialog(tr('proj.deleteTitle'), tr('proj.deleteMsg', { label: tr('list.unclassified') }), tr('proj.delete')))) return;
    try {
      const p = await api.deleteProject(projectId);
      // the server also moves the conversations; mirror it locally until their upserts arrive
      applyUpsert({ projects: [p] });
      onClose();
    } catch (e: any) { toast(e.message || tr('list.deleteFailed'), 'error'); }
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={projectId ? tr('proj.settingsTitle') : tr('sidebar.newProject')}
      footer={
        <>
          <Btn primary label={busy ? tr('set.saving') : projectId ? tr('common.save') : tr('proj.create')} disabled={busy} onPress={save} />
          <Btn label={tr('common.cancel')} onPress={onClose} />
          {!!projectId && <Btn danger label={tr('proj.delete')} onPress={del} />}
        </>
      }
    >
      <Field label={tr('set.name')} value={name} onChangeText={setName} placeholder={tr('proj.namePh')} autoFocus={!projectId} onSubmit={save} />
      <PromptEditor label={tr('label.systemPrompt')} value={prompt} onChange={setPrompt} mode={mode} onMode={setMode} hint={tr('proj.promptHint')} />
      <Label>{tr('proj.defaultModel')}</Label>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <ModelPicker sel={sel} providerName={provider?.name || ''} fallbackModel={provider?.model} hasProviders={providers.length > 0} onSelect={setSel} onAddProvider={() => {}} />
        {!!sel && <Btn small label={tr('set.clear')} onPress={() => setSel(null)} />}
      </View>
      {!sel && <Hint>{tr('proj.modelUnset')}</Hint>}
      <Label>{tr('effort.title')}</Label>
      <EffortPicker value={effort} onChange={setEffort} />
      <Hint>{tr('proj.effortHint')}</Hint>
      <ToolSearchFields tools={tools} onTools={setTools} search={search} onSearch={setSearch} inheritFrom={tr('set.fromGlobal')} />
      {dev && rfOk && <ResponseFormatEditor value={rf} onChange={setRf} hint={tr('proj.rfHint')} />}
      {dev && <View style={{ marginTop: 6 }}><ParamsEditor value={params} onChange={setParams} inheritFrom={tr('set.fromGlobal')} /></View>}
      {!!err && <Hint danger>{err}</Hint>}
    </Sheet>
  );
}
