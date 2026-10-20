import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, ApiError, getIsAdmin, uuid } from '../../api';
import type { LocalServer, Provider } from '../../protocol';
import { activeProviders, applyUpsert, setAllowOwnProviders, useStore } from '../../store';
import { addDetectedProvider, visibleServers } from '../../detectedProviders';
import { useTheme, useThemeDef } from '../../theme';
import { useT } from '../../i18n';
import { confirmDialog } from '../../ui/confirm';
import { Check } from '../../ui/kit';
import { allowedModelsOf, canAddOwnProvider, providerActions } from '../../sharedProviders';
import ContextSettings from '../../components/ContextSettings';
import { PageFrame } from './common';

// Preset names and model ids are product / brand names and technical values: not translated.
const PRESETS: { name: string; kind: string; baseUrl: string; model: string }[] = [
  { name: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { name: 'DeepSeek', kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { name: 'Ollama', kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
  { name: 'LM Studio', kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', model: 'lfm2.5-24b-a2b' },
  { name: 'DeepSeek Harness (PC bridge)', kind: 'dsh-bridge', baseUrl: 'my-pc', model: 'dsh' },
];

interface Form { id: string; name: string; kind: string; baseUrl: string; model: string; apiKey: string; hasKey: boolean; effortSupported: boolean; effortProfile: string | null }

/** Effort-sending choices; null (saved as 'standard') is the default. */
const EFFORT_PROFILES = ['standard', 'xhigh', 'think-toggle', 'none'] as const;

/** Settings > Models: auto-detected local servers, providers and the provider form. */
export default function ModelsPage({ onBack }: { onBack: () => void }) {
  const hasContextSettings = useStore((s) => s.settings?.contextOverflow !== undefined);
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const providersMap = useStore((s) => s.providers);
  const providers = activeProviders(providersMap);
  const isAdmin = getIsAdmin() === true;
  const allowOwnProviders = useStore((s) => s.allowOwnProviders);
  const canAdd = canAddOwnProvider(isAdmin, allowOwnProviders);
  const [kinds, setKinds] = useState<string[]>(['openai-compatible']);
  const [form, setForm] = useState<Form | null>(null);
  const [err, setErr] = useState('');
  const [found, setFound] = useState<LocalServer[]>([]);

  useEffect(() => {
    let alive = true;
    let timer: any = null;
    const load = async () => {
      try {
        const r = await api.localServers();
        if (alive) setFound(Array.isArray(r?.servers) ? r.servers : []);
      } catch (e: any) {
        if (!alive) return;
        setFound([]);
        if (e instanceof ApiError && e.status === 404) return; // old server: hide, stop polling
      }
      if (alive) timer = setTimeout(load, 10000);
    };
    load();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, []);
  const detected = visibleServers(found, providers.flatMap((p) => (p.baseUrl ? [{ baseUrl: p.baseUrl }] : [])));
  const addDetected = async (s: LocalServer) => {
    try {
      await addDetectedProvider(s);
      api.localServers().then((r) => setFound(r.servers || [])).catch(() => {});
    } catch {}
  };

  useEffect(() => { api.kinds().then((r) => r.kinds?.length && setKinds(r.kinds)).catch(() => {}); }, []);

  // Old servers never return effortProfile: hide the choice unless a provider shows the field (no providers = assume current server).
  const serverHasEffort = providers.length === 0 || providers.some((p) => p.effortProfile !== undefined);
  const blank = (): Form => ({ id: uuid(), name: '', kind: kinds[0] || 'openai-compatible', baseUrl: '', model: '', apiKey: '', hasKey: false, effortSupported: serverHasEffort, effortProfile: null });
  const edit = (p: Provider): Form => ({ id: p.id, name: p.name, kind: p.kind, baseUrl: p.baseUrl ?? '', model: p.model ?? '', apiKey: '', hasKey: p.hasKey ?? false, effortSupported: p.effortProfile !== undefined, effortProfile: p.effortProfile ?? null });

  const save = async () => {
    if (!form) return;
    if (!form.name.trim() || !form.baseUrl.trim() || !form.model.trim()) { setErr(tr('set.models.required')); return; }
    const isNew = !providersMap[form.id];
    try {
      const body: any = { name: form.name.trim(), kind: form.kind, baseUrl: form.baseUrl.trim(), model: form.model.trim() };
      if (form.apiKey) body.apiKey = form.apiKey;
      if (form.effortSupported && form.kind !== 'dsh-bridge') body.effortProfile = form.effortProfile;
      applyUpsert({ providers: [await api.putProvider(form.id, body)] });
      setForm(null); setErr('');
    } catch (e: any) {
      // the server refuses a new own provider while allowOwnProviders is off (403)
      if (e instanceof ApiError && e.status === 403 && isNew && !isAdmin) {
        setAllowOwnProviders(false);
        setErr(tr('shared.ownProvidersDisabled'));
        return;
      }
      setErr(e.message);
    }
  };

  /** Admin only: turns sharing of an own provider on or off. Turning it on asks first. */
  const toggleShare = async (p: Provider, on: boolean) => {
    if (on && !(await confirmDialog(tr('shared.confirmTitle'), tr('shared.confirmBody'), tr('shared.confirmOk')))) return;
    try {
      const r = await api.setProviderShared(p.id, on);
      applyUpsert({ providers: [{ ...p, shared: r.shared }] });
      setErr('');
    } catch (e: any) { setErr(e.message); }
  };
  const del = async (id: string) => {
    try { applyUpsert({ providers: [await api.deleteProvider(id)] }); if (form?.id === id) setForm(null); } catch (e: any) { setErr(e.message); }
  };

  const field = (label: string, key: keyof Form, opts: { secure?: boolean; placeholder?: string } = {}) => (
    <View>
      <Text style={[styles.label, { color: t.sub }]}>{label}</Text>
      <TextInput
        style={[styles.input, { borderRadius: th.r(8) }, { color: t.text, borderColor: t.border, backgroundColor: t.input }]}
        value={String(form![key])}
        onChangeText={(v) => setForm({ ...form!, [key]: v })}
        secureTextEntry={opts.secure}
        placeholder={opts.placeholder}
        placeholderTextColor={t.sub}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
  const btn = (label: string, onPress: () => void, primary = false, danger = false) => (
    <Pressable onPress={onPress} accessibilityRole="button" style={[styles.btn, { borderRadius: th.r(8) }, { borderColor: danger ? t.danger : t.border }, primary && { backgroundColor: t.accent, borderColor: t.accent }]}>
      <Text style={{ color: primary ? t.accentText : danger ? t.danger : t.text, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );

  return (
    <PageFrame title={tr('settings.page.models')} onBack={onBack}>
      {detected.length > 0 && (
        <>
          <Text style={[styles.section, { color: t.text }]}>{tr('set.models.autoDetected')}</Text>
          {detected.map((s) => (
            <View key={s.baseUrl} style={[styles.card, { borderRadius: th.r(12) }, { borderColor: t.border, backgroundColor: t.panel }]}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text, fontWeight: '600' }}>{s.name}</Text>
                <Text style={{ color: t.sub, fontSize: 12 }} numberOfLines={1}>{s.baseUrl} · {s.models === 1 ? tr('set.models.count1') : tr('set.models.countN', { n: s.models })}</Text>
              </View>
              {btn(tr('common.add'), () => addDetected(s), true)}
            </View>
          ))}
        </>
      )}
      <Text style={[styles.section, { color: t.text, marginTop: detected.length ? 14 : 0 }]}>{tr('set.models.providers')}</Text>
      {providers.length === 0 && <Text style={{ color: t.sub }}>{tr('set.models.noProviders')}</Text>}
      {providers.map((p) => {
        const act = providerActions(p, isAdmin);
        const allowed = allowedModelsOf(p);
        const sub = act.readOnly
          ? `${p.kind} · ${allowed === 'all' ? tr('shared.allModels') : tr('shared.someModels', { n: allowed.length })}`
          : `${p.kind} · ${p.baseUrl} · ${p.model}${p.hasKey ? tr('set.models.keySet') : ''}`;
        return (
          <View key={p.id} style={{ gap: 6 }}>
            <View style={[styles.card, { borderRadius: th.r(12) }, { borderColor: t.border, backgroundColor: t.panel }]}>
              <View style={{ flex: 1 }}>
                <View style={styles.nameRow}>
                  <Text style={{ color: t.text, fontWeight: '600' }}>{p.name}</Text>
                  {act.showSharedBadge && (
                    <View style={[styles.badge, { borderRadius: th.r(6), borderColor: t.accent }]}>
                      <Text style={{ color: t.accent, fontSize: 11, fontWeight: '600' }}>{tr('shared.badge')}</Text>
                    </View>
                  )}
                </View>
                <Text style={{ color: t.sub, fontSize: 12 }} numberOfLines={1}>{sub}</Text>
                {act.readOnly && <Text style={{ color: t.sub, fontSize: 12 }}>{tr('shared.readOnlyNote')}</Text>}
              </View>
              {act.canEdit && btn(tr('common.edit'), () => { setForm(edit(p)); setErr(''); })}
              {act.canDelete && btn(tr('common.delete'), () => del(p.id), false, true)}
            </View>
            {act.canShare && (
              <View style={{ paddingHorizontal: 4 }}>
                <Check label={tr('shared.toggle')} value={p.shared === true} onChange={(v) => void toggleShare(p, v)} hint={tr('shared.toggleHint')} />
              </View>
            )}
          </View>
        );
      })}
      {!form && canAdd && btn(tr('set.models.addProvider'), () => { setForm(blank()); setErr(''); }, true)}
      {!form && !canAdd && <Text style={{ color: t.sub, marginTop: 4 }}>{tr('shared.ownProvidersDisabled')}</Text>}
      {form && (
        <View style={[styles.card, { borderRadius: th.r(12) }, { borderColor: t.border, backgroundColor: t.panel, flexDirection: 'column', alignItems: 'stretch' }]}>
          <Text style={{ color: t.sub, fontSize: 12 }}>{tr('set.models.presets')}</Text>
          <View style={styles.row}>
            {PRESETS.map((p) => btn(p.name, () => setForm({ ...form, name: form.name || p.name, kind: p.kind, baseUrl: p.baseUrl, model: p.model })))}
          </View>
          {field(tr('set.name'), 'name')}
          <Text style={[styles.label, { color: t.sub }]}>{tr('set.kind')}</Text>
          <View style={styles.row}>
            {kinds.map((k) => (
              <Pressable key={k} onPress={() => setForm({ ...form, kind: k })} style={[styles.btn, { borderRadius: th.r(8) }, { borderColor: t.border }, form.kind === k && { backgroundColor: t.accent, borderColor: t.accent }]}>
                <Text style={{ color: form.kind === k ? t.accentText : t.text }}>{k}</Text>
              </Pressable>
            ))}
          </View>
          {form.kind === 'dsh-bridge' ? (
            <>
              {field(tr('set.models.bridgeName'), 'baseUrl', { placeholder: 'my-pc' })}
              {field(tr('set.label'), 'model', { placeholder: 'dsh' })}
              <Text style={{ color: t.sub, fontSize: 12, marginTop: 8 }}>{tr('set.models.bridgeNote')}</Text>
            </>
          ) : (
            <>
              {field(tr('set.baseUrl'), 'baseUrl', { placeholder: 'https://api.openai.com/v1' })}
              {field(tr('set.model'), 'model', { placeholder: 'gpt-4o-mini' })}
              {field(tr('set.apiKey'), 'apiKey', { secure: true, placeholder: form.hasKey ? tr('set.unchanged') : '' })}
              {form.effortSupported && (
                <>
                  <Text style={[styles.label, { color: t.sub }]}>{tr('set.models.effortProfile')}</Text>
                  <View style={styles.row}>
                    {EFFORT_PROFILES.map((k) => {
                      const on = (form.effortProfile ?? 'standard') === k;
                      return (
                        <Pressable key={k} onPress={() => setForm({ ...form, effortProfile: k })} accessibilityRole="button" style={[styles.btn, { borderRadius: th.r(8) }, { borderColor: t.border }, on && { backgroundColor: t.accent, borderColor: t.accent }]}>
                          <Text style={{ color: on ? t.accentText : t.text }}>{tr(`set.models.effortProfile.${k}`)}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  <Text style={{ color: t.sub, fontSize: 12, marginTop: 4 }}>{tr('set.models.effortProfile.hint')}</Text>
                </>
              )}
            </>
          )}
          {!!err && <Text style={{ color: t.danger, marginTop: 8 }}>{err}</Text>}
          <View style={[styles.row, { marginTop: 12 }]}>
            {btn(tr('common.save'), save, true)}
            {btn(tr('common.cancel'), () => { setForm(null); setErr(''); })}
          </View>
        </View>
      )}
      {!form && !!err && <Text style={{ color: t.danger }}>{err}</Text>}
      {/* the settings search points context overflow / limits / compression here (settingsMeta page 'models') */}
      {!form && hasContextSettings && <ContextSettings />}
    </PageFrame>
  );
}

const styles = StyleSheet.create({
  section: { fontSize: 16, fontWeight: '700' },
  card: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, padding: 12 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  badge: { borderWidth: 1, paddingHorizontal: 6, paddingVertical: 1 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  label: { fontSize: 12, marginTop: 10, marginBottom: 4 },
  input: { borderWidth: 1, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15 },
  btn: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8, alignItems: 'center', alignSelf: 'flex-start' },
});
