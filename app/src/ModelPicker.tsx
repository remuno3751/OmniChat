import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { api } from './api';
import type { ModelGroup, ModelInfo, ModelState } from './protocol';
import { codeModelView, fromCodeSel, type KindOf } from './codeModels';
import type { ModelSel } from './store';
import { useTheme, useThemeDef } from './theme';
import { Brackets, DottedInner } from './ui/decor';
import { useFaces } from './ui/skin';
import { KeyboardAvoid, useInsets, useKeyboard } from './ui/safe';
import Icon from './components/Icon';
import ModelLogo from './components/ModelLogo';
import MarqueeText from './components/MarqueeText';
import { t, useT } from './i18n';

// ---- shared model-list cache (one fetch shared by all consumers) ----
let cache: ModelGroup[] | null = null;
let cacheError = '';
let loading = false;
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());

let silentLoad = false;
let again: { force: boolean } | null = null;

/** force => ?refresh=1; silent => no spinner, keeps the previous list/error on failure. */
export async function refreshModels(force = false, silent = false) {
  if (loading) { again = { force: force || !!again?.force }; return; }
  loading = true; silentLoad = silent;
  if (!silent) cacheError = '';
  notify();
  try {
    cache = (await api.models(force)).groups || [];
    cacheError = '';
  } catch (e: any) {
    if (!silent) cacheError = e?.message || String(e);
  }
  loading = false; silentLoad = false; notify();
  if (again) { const a = again; again = null; refreshModels(a.force, true); }
}

export function useModelGroups() {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    subs.add(f);
    if (cache === null && !loading) refreshModels();
    return () => { subs.delete(f); };
  }, []);
  return { groups: cache, loading: loading && !silentLoad, error: cacheError };
}

/** First available model in the list that the conversation's model is missing from, or null when it is fine. */
export function missingModel(groups: ModelGroup[] | null, sel: ModelSel | null, fallbackModel?: string) {
  if (!groups || !sel) return null;
  const id = sel.model || fallbackModel || '';
  if (!id || id === 'default') return null;
  const g = groups.find((x) => x.providerId === sel.providerId);
  if (!g || g.error || g.models.some((m) => m.id === id)) return null;
  return { group: g, first: g.models[0] || null };
}

/** The ModelInfo of the selected model (for effort support / state). */
export function selectedModelInfo(groups: ModelGroup[] | null, sel: ModelSel | null, fallbackModel?: string): ModelInfo | null {
  if (!groups || !sel) return null;
  const id = sel.model || fallbackModel || '';
  return groups.find((x) => x.providerId === sel.providerId)?.models.find((m) => m.id === id) || null;
}

const fmtBytes = (n: number) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.round(n / 1e6) + ' MB');
export function stateLine(st: ModelState | undefined): string {
  if (!st) return '';
  const parts: string[] = [];
  if (st.quantization) parts.push(st.quantization);
  if (st.vramBytes) parts.push(fmtBytes(st.vramBytes) + ' VRAM');
  else if (st.sizeBytes) parts.push(fmtBytes(st.sizeBytes));
  { const c = (st.loaded ? st.loadedContextLength : undefined) ?? st.contextLength; if (c) parts.push(t('model.ctx', { n: c >= 1000 ? Math.round(c / 1024) + 'k' : c })); }
  return parts.join(' · ');
}

function appVisible() {
  if (AppState.currentState && AppState.currentState !== 'active') return false;
  const d: any = (globalThis as any).document;
  return !(d && d.visibilityState === 'hidden');
}

export function resetModelCache() { cache = null; cacheError = ''; notify(); }

/** Display name for a model id (modelRef or plain id). */
export function modelLabel(groups: ModelGroup[] | null, sel: ModelSel | null, fallbackModel?: string): string {
  if (!sel) return '';
  const id = sel.model || fallbackModel || '';
  if (!id) return t('model.defaultName');
  const g = groups?.find((x) => x.providerId === sel.providerId);
  const hit = g?.models.find((m) => m.id === id);
  if (hit) return hit.name;
  const i = id.indexOf('::');
  return i >= 0 ? id.slice(i + 2) : id;
}

interface Props {
  sel: ModelSel | null;
  providerName: string;
  fallbackModel?: string;
  hasProviders: boolean;
  onSelect: (sel: ModelSel) => void;
  onAddProvider: () => void;
  /** Code tab: list only the dsh-bridge models (see codeModelView). */
  codeMode?: boolean;
  /** Opens the picker each time this number changes (e.g. the /model slash command). */
  openToken?: number;
}

const FILTER_MIN = 8;

export default function ModelPicker({ sel, providerName, fallbackModel, hasProviders, onSelect, onAddProvider, codeMode, openToken }: Props) {
  const t = useTheme();
  const th = useThemeDef();
  const themed = th.def.id !== 'simple';
  const faces = useFaces();
  const tr = useT();
  const { width } = useWindowDimensions();
  const wide = width >= 700;
  const ins = useInsets();
  const kb = useKeyboard();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [customFor, setCustomFor] = useState<string | null>(null);
  const [custom, setCustom] = useState('');
  const { groups, loading: busy, error } = useModelGroups();
  const [now, setNow] = useState(Date.now());
  const [busyModel, setBusyModel] = useState<Record<string, boolean>>({});
  const [modelErr, setModelErr] = useState<Record<string, string>>({});
  const [ctxFor, setCtxFor] = useState<string | null>(null);
  const [ctxVal, setCtxVal] = useState('');

  const manage = async (providerId: string, model: string, action: 'load' | 'unload', contextLength?: number) => {
    const key = providerId + '::' + model;
    setBusyModel((b) => ({ ...b, [key]: true }));
    setModelErr((e) => ({ ...e, [key]: '' }));
    try {
      await (action === 'load' ? api.loadModel(providerId, model, contextLength) : api.unloadModel(providerId, model));
    } catch (e: any) {
      setModelErr((x) => ({ ...x, [key]: e?.status === 501 ? tr('model.notSupported') : e?.message || tr('model.opFailed') }));
    }
    setCtxFor(null);
    await refreshModels(true, true);
    setBusyModel((b) => ({ ...b, [key]: false }));
  };

  // refetch on app foreground / window focus
  useEffect(() => {
    const go = () => { if (appVisible()) refreshModels(false, true); };
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') go(); });
    const w: any = (globalThis as any).window;
    const d: any = (globalThis as any).document;
    w?.addEventListener?.('focus', go);
    d?.addEventListener?.('visibilitychange', go);
    return () => { sub.remove(); w?.removeEventListener?.('focus', go); d?.removeEventListener?.('visibilitychange', go); };
  }, []);

  // poll while the picker is open (and the app is visible)
  useEffect(() => {
    if (!open) return;
    const poll = setInterval(() => { if (appVisible()) refreshModels(false, true); }, 8000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [open]);

  // open from outside: a changed openToken opens the picker (the first render does not)
  const openSeen = useRef(openToken ?? 0);
  useEffect(() => {
    const n = openToken ?? 0;
    if (n === openSeen.current) return;
    openSeen.current = n;
    if (!hasProviders) return;
    setOpen(true);
    setNow(Date.now());
    refreshModels();
  }, [openToken, hasProviders]);

  // Code: the selection is the bridge plus `<providerId>::<model>` for a model of a normal provider; show that model
  const kindOf = useCallback<KindOf>((id) => groups?.find((g) => g.providerId === id)?.kind, [groups]);
  const dsel = useMemo(() => (codeMode && sel ? fromCodeSel(sel, kindOf) : sel), [codeMode, sel, kindOf]);
  // a Code device with no model yet is not a missing model (its list has only placeholders)
  const missing = useMemo(() => (codeMode && !dsel?.model ? null : missingModel(groups, dsel, fallbackModel)), [codeMode, groups, dsel, fallbackModel]);
  const fetchedAt = useMemo(() => Math.max(0, ...(groups || []).map((g) => g.fetchedAt || 0)), [groups]);
  const ago = fetchedAt ? Math.max(0, Math.round((now - fetchedAt) / 1000)) : -1;

  const total = useMemo(() => (groups || []).reduce((n, g) => n + g.models.length, 0), [groups]);
  const view = useMemo(
    () => (codeMode ? codeModelView(groups, sel ? sel.providerId : null, { current: tr('model.dshCurrent'), imported: tr('model.dshImported') }) : { groups, fallback: false, dshNote: false }),
    [codeMode, groups, sel, tr],
  );
  const q = filter.trim().toLowerCase();
  const effModel = dsel ? dsel.model || fallbackModel || '' : '';

  const close = useCallback(() => { setOpen(false); setFilter(''); setCustomFor(null); setCustom(''); }, []);
  const pick = (providerId: string, model: string | null) => { onSelect({ providerId, model }); close(); };

  const label = !hasProviders ? tr('model.addProvider') : dsel ? modelLabel(groups, dsel, fallbackModel) : tr('model.select');
  const subName = codeMode && dsel !== sel ? groups?.find((g) => g.providerId === dsel?.providerId)?.providerName ?? providerName : providerName;
  const sub = hasProviders && dsel ? subName : '';

  const onButton = () => {
    if (!hasProviders) { onAddProvider(); return; }
    setOpen(true);
    setNow(Date.now());
    refreshModels();
  };

  const body = (
    <>
      <View style={styles.topRow}>
        <Text style={[styles.heading, { color: t.text }, faces.headingBold, th.def.fonts.labelCaps && { fontSize: 13, textTransform: 'uppercase', letterSpacing: th.def.fonts.labelTracking }]}>{tr('model.heading')}</Text>
        <Pressable onPress={() => refreshModels(true)} hitSlop={8} accessibilityLabel={tr('model.refresh')} disabled={busy}>
          {busy ? <ActivityIndicator size="small" color={t.accentInk} /> : <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}><Icon name="refresh" size={16} color={t.accentInk} /><Text style={{ color: t.accentInk, fontSize: 15 }}>{tr('common.refresh')}</Text></View>}
        </Pressable>
      </View>
      {missing && (
        <View style={[styles.warn, { borderColor: t.danger, borderRadius: th.r(8) }]}>
          <Text style={{ color: t.danger, fontSize: 13, fontWeight: '600' }}>{tr('model.unavailable')}</Text>
          {missing.first ? (
            <Pressable onPress={() => pick(missing.group.providerId, missing.first!.id)} hitSlop={6} accessibilityRole="button">
              <Text style={{ color: t.accentInk, fontSize: 13, marginTop: 2 }}>{tr('model.switchTo', { name: missing.first.name })}</Text>
            </Pressable>
          ) : null}
        </View>
      )}
      {total > FILTER_MIN && (
        <TextInput
          value={filter}
          onChangeText={setFilter}
          placeholder={tr('model.filter')}
          placeholderTextColor={t.sub}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.field, { borderRadius: th.r(8), color: t.text, borderColor: t.border, backgroundColor: t.input }, Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : null]}
        />
      )}
      <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled">
        {codeMode && view.dshNote && <Text style={{ color: t.sub, fontSize: 12, padding: 12 }}>{tr('model.dshFallback')}</Text>}
        {!!error && <Text style={[styles.err, { color: t.danger }]}>{error}</Text>}
        {groups === null && !error && <ActivityIndicator color={t.accentInk} style={{ margin: 16 }} />}
        {groups?.length === 0 && <Text style={{ color: t.sub, padding: 12 }}>{tr('model.noProviders')}</Text>}
        {(view.groups || []).map((g) => {
          const models = q ? g.models.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)) : g.models;
          const customOpen = customFor === g.providerId;
          return (
            <View key={g.providerId + '|' + (g.subKey ?? '')} style={{ marginBottom: 6 }}>
              <Text style={[styles.group, { color: t.sub }, faces.labelBold]}>{g.providerName}</Text>
              {!!g.error && <Text style={[styles.err, { color: t.danger }]} numberOfLines={3}>{g.error}</Text>}
              {models.map((m) => {
                const on = !!dsel && dsel.providerId === g.providerId && effModel === m.id;
                const key = g.providerId + '::' + m.id;
                const st = m.state;
                const line = stateLine(st);
                const canLoad = !!g.capabilities?.load && !st?.loaded;
                const canUnload = !!g.capabilities?.unload && !!st?.loaded;
                const canCtx = !!g.capabilities?.load && (!st?.loaded || !!g.capabilities?.unload);
                const ctxOpen = ctxFor === key;
                return (
                  <View key={m.id}>
                    <Pressable
                      onPress={() => pick(g.providerId, m.id)}
                      style={({ hovered }: any) => [styles.row, { borderRadius: th.r(8) }, on && { backgroundColor: t.border }, hovered && { backgroundColor: t.border }, themed && (on || hovered) && { backgroundColor: t.panel2 }, themed && { borderLeftWidth: 3, borderLeftColor: on ? (th.def.variants.tabs === 'tag' ? t.accent : t.accent2) : 'transparent' }]}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                    >
                      {st && typeof st.loaded === 'boolean' && (
                        <View accessibilityLabel={st.loaded ? tr('model.loaded') : tr('model.notLoaded')} style={[styles.dot, { backgroundColor: st.loaded ? t.accent : 'transparent', borderColor: st.loaded ? t.accent : t.sub }]} />
                      )}
                      <ModelLogo model={m.id} size={22} publisher={m.state?.publisher} />
                      <View style={{ flex: 1 }}>
                        <MarqueeText style={[styles.rowText, { color: t.text }]}>{m.name}</MarqueeText>
                        {!!line && <MarqueeText style={{ color: t.sub, fontSize: 11 }}>{line}</MarqueeText>}
                      </View>
                      {busyModel[key] ? <ActivityIndicator size="small" color={t.accentInk} /> : (
                        <>
                          {canLoad && <Pressable onPress={() => manage(g.providerId, m.id, 'load')} hitSlop={6} accessibilityLabel={tr('model.loadNamed', { name: m.name })} style={[styles.mbtn, { borderRadius: th.r(6), borderColor: t.border }]}><Text style={{ color: t.text, fontSize: 12 }}>{tr('model.load')}</Text></Pressable>}
                          {canCtx && <Pressable onPress={() => { setCtxFor(ctxOpen ? null : key); setCtxVal(String(st?.loadedContextLength || st?.contextLength || 8192)); }} hitSlop={6} accessibilityLabel={tr('model.ctxNamed', { name: m.name })} style={[styles.mbtn, { borderRadius: th.r(6), borderColor: t.border }]}><Text style={{ color: t.text, fontSize: 12 }}>{tr('model.ctxBtn')}</Text></Pressable>}
                          {canUnload && <Pressable onPress={() => manage(g.providerId, m.id, 'unload')} hitSlop={6} accessibilityLabel={tr('model.unloadNamed', { name: m.name })} style={[styles.mbtn, { borderRadius: th.r(6), borderColor: t.border }]}><Text style={{ color: t.text, fontSize: 12 }}>{tr('model.unload')}</Text></Pressable>}
                        </>
                      )}
                      {on && <Icon name="check" size={18} color={t.accentInk} />}
                    </Pressable>
                    {ctxOpen && (
                      <View style={[styles.row, { flexWrap: 'wrap', gap: 6 }]}>
                        <Text style={{ color: t.sub, fontSize: 12 }}>{tr('model.ctxSizeTokens')}{st?.contextLength ? ` · ${tr('model.ctxMax', { n: st.contextLength })}` : ''}</Text>
                        <TextInput
                          value={ctxVal}
                          onChangeText={(v) => setCtxVal(v.replace(/[^0-9]/g, ''))}
                          keyboardType="number-pad"
                          accessibilityLabel={tr('model.ctxSize')}
                          style={[styles.field, { borderRadius: th.r(8), width: 100, marginBottom: 0, color: t.text, borderColor: t.border, backgroundColor: t.input }, Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : null]}
                        />
                        {[4096, 8192, 16384, 32768, 65536].filter((n) => !st?.contextLength || n <= st.contextLength).map((n) => (
                          <Pressable key={n} onPress={() => setCtxVal(String(n))} hitSlop={4} style={[styles.mbtn, { borderRadius: th.r(6), borderColor: t.border }]}><Text style={{ color: t.text, fontSize: 12 }}>{n / 1024}k</Text></Pressable>
                        ))}
                        <Pressable
                          onPress={() => { const n = parseInt(ctxVal, 10); if (n >= 256) manage(g.providerId, m.id, 'load', n); }}
                          hitSlop={6}
                          accessibilityLabel={tr('model.loadCtxNamed', { name: m.name })}
                          style={[styles.mbtn, { borderRadius: th.r(6), borderColor: t.accent }]}
                        ><Text style={{ color: t.accentInk, fontSize: 12, fontWeight: '600' }}>{st?.loaded ? tr('model.reload') : tr('model.load')}</Text></Pressable>
                      </View>
                    )}
                    {!!modelErr[key] && <Text style={[styles.err, { color: t.danger }]}>{modelErr[key]}</Text>}
                  </View>
                );
              })}
              {q && models.length === 0 && !g.error && <Text style={{ color: t.sub, paddingHorizontal: 12, paddingVertical: 4, fontSize: 13 }}>{tr('model.noMatches')}</Text>}
              {customOpen ? (
                <View style={styles.row}>
                  <TextInput
                    autoFocus
                    value={custom}
                    onChangeText={setCustom}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder={tr('model.customPlaceholder')}
                    placeholderTextColor={t.sub}
                    onSubmitEditing={() => { const v = custom.trim(); if (v) pick(g.providerId, v); }}
                    style={[styles.field, { borderRadius: th.r(8), flex: 1, marginBottom: 0, color: t.text, borderColor: t.border, backgroundColor: t.input }, Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : null]}
                  />
                  <Pressable onPress={() => { const v = custom.trim(); if (v) pick(g.providerId, v); }} hitSlop={6} style={{ marginLeft: 8 }}>
                    <Text style={{ color: t.accentInk, fontWeight: '600' }}>{tr('model.use')}</Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  onPress={() => { setCustomFor(g.providerId); setCustom(''); }}
                  style={({ hovered }: any) => [styles.row, { borderRadius: th.r(8) }, hovered && { backgroundColor: themed ? t.panel2 : t.border }]}
                  accessibilityRole="button"
                >
                  <Text style={[styles.rowText, { color: t.sub }]}>{tr('model.customId')}</Text>
                </Pressable>
              )}
            </View>
          );
        })}
      </ScrollView>
      {ago >= 0 && <Text style={[styles.foot, { color: t.sub }]}>{ago < 2 ? tr('model.updatedJust') : ago < 60 ? tr('model.updatedSec', { n: ago }) : tr('model.updatedMin', { n: Math.floor(ago / 60) })}</Text>}
    </>
  );

  return (
    <>
      <Pressable onPress={onButton} style={[styles.btn, { borderColor: t.border, borderRadius: th.r(14) }]} accessibilityRole="button" accessibilityLabel={tr('model.choose')}>
        {hasProviders && sel && effModel ? <ModelLogo model={effModel} size={20} publisher={selectedModelInfo(groups, sel, fallbackModel)?.state?.publisher} /> : null}
        <View style={{ flexShrink: 1 }}>
          <Text numberOfLines={1} style={{ color: t.text, fontSize: 14, fontWeight: '600' }}>{missing ? <Text style={{ color: t.danger }} accessibilityLabel={tr('model.notAvailable')}><Icon name="warning" size={13} color={t.danger} /> </Text> : null}{label}</Text>
          {!!sub && wide && <Text numberOfLines={1} style={{ color: t.sub, fontSize: 11 }}>{sub}</Text>}
        </View>
        {hasProviders && <Icon name="expand" size={16} color={t.sub} />}
      </Pressable>
      <Modal visible={open} transparent animationType={th.reduceMotion ? 'none' : wide ? 'fade' : 'slide'} onRequestClose={close} statusBarTranslucent navigationBarTranslucent>
        <Pressable style={[styles.backdrop, wide ? null : { backgroundColor: 'rgba(0,0,0,0.4)' }]} onPress={close} accessibilityLabel={tr('model.closePicker')} />
        <KeyboardAvoid
          pointerEvents="box-none"
          style={[StyleSheet.absoluteFill, wide ? styles.popWrap : styles.sheetWrap, wide && { paddingTop: 56 + ins.top }]}
        >
          <View
            style={[
              wide ? styles.popover : styles.sheet,
              { backgroundColor: t.panel, borderColor: th.def.shape.bracket ? t.borderStrong : t.border },
              wide && { borderRadius: th.r(14) },
              !wide && { borderTopLeftRadius: th.r(18), borderTopRightRadius: th.r(18) },
              !wide && { paddingBottom: 24 + (kb.visible ? 0 : ins.bottom) },
              wide && th.def.shadow.kind === 'soft' && th.fx ? { shadowOpacity: th.def.shadow.opacity, shadowRadius: th.def.shadow.radius } : null,
            ]}
          >
            <Brackets inset={-1} />
            <DottedInner inset={4} radius={Math.max(0, th.r(14) - 4)} />
            {!wide && <View style={[styles.grab, { backgroundColor: t.border }]} />}
            {body}
          </View>
        </KeyboardAvoid>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  btn: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5, maxWidth: 220, flexShrink: 1 },
  backdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  popWrap: { alignItems: 'flex-end', justifyContent: 'flex-start', paddingTop: 56, paddingRight: 16 },
  sheetWrap: { justifyContent: 'flex-end' },
  popover: { width: 380, maxWidth: '100%', maxHeight: '70%', borderWidth: 1, borderRadius: 14, padding: 8, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 8 },
  sheet: { width: '100%', maxHeight: '80%', borderTopLeftRadius: 18, borderTopRightRadius: 18, borderWidth: 1, borderBottomWidth: 0, padding: 12, paddingBottom: 24 },
  grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, marginBottom: 8 },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8, paddingVertical: 6 },
  heading: { fontSize: 16, fontWeight: '700' },
  field: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, marginHorizontal: 4, marginBottom: 6, fontSize: 15 },
  group: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 2 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8 },
  rowText: { flex: 1, fontSize: 15 },
  warn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, marginHorizontal: 4, marginBottom: 6 },
  foot: { fontSize: 11, textAlign: 'center', paddingTop: 6 },
  err: { fontSize: 12, paddingHorizontal: 12, paddingVertical: 2 },
  dot: { width: 9, height: 9, borderRadius: 5, borderWidth: 1.5 },
  mbtn: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
});
