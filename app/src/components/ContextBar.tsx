import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { api } from '../api';
import { limitKey, setOverflowNotice, useContextUsage, useOverflowNotice } from '../contextState';
import type { CtxArgs } from '../contextState';
import type { ContextOverflow, ContextUsage } from '../protocol';
import { applyUpsert, patchSettingsLocal, useStore } from '../store';
import { getDevice } from '../deviceSettings';
import { resolveLanguage, useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';
import { Btn, Field, Hint, Sheet, useDevMode } from '../ui/kit';
import { toast } from '../ui/toast';

type Tr = (key: string, vars?: Record<string, string | number>) => string;
/** Numbers follow the active app language (not a fixed locale). */
const n = (v: number) => v.toLocaleString(resolveLanguage(getDevice().language));
export const overflowLabel = (tr: Tr, m: ContextOverflow): string => tr(`composer.context.overflow.${m}`);
const overflowHint = (tr: Tr, m: ContextOverflow): string => tr(`composer.context.hint.${m}`);
const useOverflowMode = (): ContextOverflow => useStore((s) => s.settings?.contextOverflow || 'summarize');

type Level = 'ok' | 'warn' | 'full' | 'unknown';
function levelOf(u: ContextUsage): { level: Level; pct: number } {
  if (!u.limit) return { level: 'unknown', pct: 0 };
  const pct = u.total / u.limit;
  if (!u.fits) return { level: 'full', pct };
  return { level: pct >= 0.8 ? 'warn' : 'ok', pct };
}

/** "used / limit tokens" bar above the composer; tap for the breakdown. Hidden against servers without the endpoint. */
export default function ContextBar(props: { args: CtxArgs; extra?: React.ReactNode }) {
  const t = useTheme();
  const tr = useT();
  const u = useContextUsage(props.args);
  const mode = useOverflowMode();
  const [open, setOpen] = useState(false);
  if (!u) return null;
  const { level, pct } = levelOf(u);
  const color = level === 'full' ? t.danger : level === 'warn' ? t.warn : t.accent;
  const approx = u.estimated ? '~' : '';
  const label = u.limit
    ? tr('composer.context.usage', { approx, used: n(u.total), limit: n(u.limit), pct: Math.min(999, Math.round(pct * 100)) })
    : tr('composer.context.usageNoLimit', { approx, used: n(u.total) });
  return (
    <View style={styles.wrap}>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={tr('composer.context.a11y', { label })} hitSlop={{ top: 6, bottom: 6 }}>
        <View style={styles.line}>
          <Text style={{ color: level === 'ok' || level === 'unknown' ? t.sub : color, fontSize: 11, fontWeight: level === 'ok' || level === 'unknown' ? '400' : '700', flexShrink: 1 }} numberOfLines={1}>
            {tr('composer.context.prefix', { label })}
          </Text>
          <Text style={{ color: t.sub, fontSize: 11 }}>{tr('composer.context.details')}</Text>
        </View>
        <View style={[styles.track, { backgroundColor: t.border }]}>
          {u.limit ? <View style={{ width: `${Math.min(100, pct * 100)}%`, height: 4, backgroundColor: color, borderRadius: 2 }} /> : null}
        </View>
      </Pressable>
      {(level === 'warn' || level === 'full') && (
        <Text style={{ color, fontSize: 11, marginTop: 2 }}>
          {level === 'full' ? tr('composer.context.doesNotFit') : tr('composer.context.nearlyFull')} {overflowHint(tr, mode)}
        </Text>
      )}
      {props.extra}
      <ContextSheet visible={open} onClose={() => setOpen(false)} u={u} providerId={props.args.providerId} model={props.args.model} />
    </View>
  );
}

const SEG_COLORS = ['#6366f1', '#10a37f', '#f59e0b', '#ec4899', '#0ea5e9'];

function ContextSheet({ visible, onClose, u, providerId, model }: { visible: boolean; onClose: () => void; u: ContextUsage; providerId: string | null; model: string | null }) {
  const t = useTheme();
  const tr = useT();
  const dev = useDevMode();
  const mode = useOverflowMode();
  const limits = useStore((s) => s.settings?.contextLimits);
  const [val, setVal] = useState('');
  const { level } = levelOf(u);
  const rows: [string, number][] = [
    [tr('composer.context.row.system'), u.used.system], [tr('composer.context.row.history'), u.used.history], [tr('composer.context.row.attachments'), u.used.attachments], [tr('composer.context.row.tools'), u.used.tools], [tr('composer.context.row.input'), u.used.input],
  ];
  if (u.reasoning > 0) rows.push([tr('composer.context.row.reasoning'), u.reasoning]);
  const sum = rows.reduce((a, r) => a + r[1], 0) || 1;
  const key = providerId && model ? limitKey(providerId, model) : null;
  const source = u.limitSource === 'backend' ? tr('sheet.context.srcBackend') : u.limitSource === 'override' ? tr('sheet.context.srcOverride') : tr('msg.unknown');

  const saveLimit = async (clear: boolean) => {
    if (!key) return;
    const next = { ...(limits || {}) };
    const num = parseInt(val.replace(/[^0-9]/g, ''), 10);
    if (clear) delete next[key]; else if (num > 0) next[key] = num; else return;
    patchSettingsLocal({ contextLimits: next });
    try { applyUpsert({ settings: await api.putSettings({ contextLimits: Object.keys(next).length ? next : null }) }); setVal(''); toast(tr('sheet.context.limitSaved'), 'ok'); }
    catch (e: any) { toast(e.message || tr('sheet.context.saveFailed'), 'error'); }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={tr('sheet.context.title')} width={440}>
      <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>
        {u.limit
          ? tr('composer.context.usage', { approx: u.estimated ? '~' : '', used: n(u.total), limit: n(u.limit), pct: Math.round((u.total / u.limit) * 100) })
          : tr('sheet.context.totalNoLimit', { approx: u.estimated ? '~' : '', used: n(u.total) })}
      </Text>
      <View style={[styles.stack, { backgroundColor: t.border }]}>
        {rows.map(([name, v], i) => (v > 0 ? <View key={name} accessibilityLabel={name} style={{ flex: v / sum, backgroundColor: SEG_COLORS[i % SEG_COLORS.length] }} /> : null))}
      </View>
      {rows.map(([name, v], i) => (
        <View key={name} style={styles.row}>
          <View style={[styles.dot, { backgroundColor: SEG_COLORS[i % SEG_COLORS.length] }]} />
          <Text style={{ color: t.text, flex: 1, fontSize: 14 }}>{name}</Text>
          <Text style={{ color: t.text, fontSize: 14 }}>{u.estimated ? '~' : ''}{n(v)}</Text>
        </View>
      ))}
      <View style={[styles.row, { borderTopWidth: 1, borderColor: t.border, marginTop: 6, paddingTop: 8 }]}>
        <Text style={{ color: t.sub, flex: 1, fontSize: 13 }}>{tr('sheet.context.lastThinking')}</Text>
        <Text style={{ color: t.sub, fontSize: 13 }}>{n(u.lastReasoning)}</Text>
      </View>
      <View style={styles.row}>
        <Text style={{ color: t.sub, flex: 1, fontSize: 13 }}>{tr('sheet.context.reserved')}</Text>
        <Text style={{ color: t.sub, fontSize: 13 }}>{n(u.reserve)}</Text>
      </View>
      <View style={styles.row}>
        <Text style={{ color: t.sub, flex: 1, fontSize: 13 }}>{tr('sheet.context.limit', { source })}</Text>
        <Text style={{ color: t.sub, fontSize: 13 }}>{u.limit ? n(u.limit) : tr('msg.unknown')}</Text>
      </View>
      {u.estimated && <Hint>{tr('sheet.context.estimated')}</Hint>}
      {level === 'unknown' && <Hint>{tr('sheet.context.unknownHint')}</Hint>}
      {level === 'full' && <Hint danger>{tr('sheet.context.doesNotFit')}</Hint>}
      <Hint>{tr('sheet.context.changeHint', { hint: overflowHint(tr, mode) })}</Hint>
      {dev && !!key && (
        <View style={{ marginTop: 10 }}>
          <Field label={tr('sheet.context.overrideFor', { model: model ?? '' })} value={val} onChangeText={setVal} keyboardType="numeric" placeholder={limits?.[key] ? String(limits[key]) : tr('sheet.context.overridePlaceholder')} />
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <Btn small primary label={tr('common.save')} disabled={!val.trim()} onPress={() => saveLimit(false)} />
            {!!limits?.[key] && <Btn small label={tr('sheet.context.removeOverride')} onPress={() => saveLimit(true)} />}
          </View>
        </View>
      )}
    </Sheet>
  );
}

/** Banner for a WS `context_overflow` error: explains it and offers the Drop oldest shortcut. */
export function OverflowBanner() {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const msg = useOverflowNotice();
  const mode = useOverflowMode();
  if (!msg) return null;
  const sw = async () => {
    patchSettingsLocal({ contextOverflow: 'truncate' });
    try {
      applyUpsert({ settings: await api.putSettings({ contextOverflow: 'truncate' }) });
      toast(tr('composer.context.switched'), 'ok');
    } catch (e: any) { toast(e.message || tr('composer.context.switchFailed'), 'error'); }
    setOverflowNotice(null);
  };
  return (
    <View style={[styles.banner, { borderColor: t.danger, backgroundColor: t.panel, borderRadius: th.r(10) }]} accessibilityRole="alert">
      <Text style={{ color: t.danger, fontWeight: '700', fontSize: 13 }}>{tr('composer.context.banner.title')}</Text>
      <Text style={{ color: t.text, fontSize: 13, marginTop: 2 }}>{msg}</Text>
      <Text style={{ color: t.sub, fontSize: 12, marginTop: 2 }}>{tr('composer.context.banner.body', { mode: overflowLabel(tr, mode) })}</Text>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {mode !== 'truncate' && <Btn small primary label={tr('composer.context.banner.switch')} onPress={sw} />}
        <Btn small label={tr('composer.context.banner.dismiss')} onPress={() => setOverflowNotice(null)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingTop: 6 },
  line: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, marginBottom: 3 },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  stack: { flexDirection: 'row', height: 10, borderRadius: 5, overflow: 'hidden', marginVertical: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  banner: { marginHorizontal: 12, marginBottom: 4, borderWidth: 1, padding: 10 },
});
