import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ToolCall, ToolCallStatus, ToolPermission } from '../protocol';
import { PERM_LABEL, permDanger } from '../toolState';
import { decidedByLabel } from '../approvalMode';
import { Theme, useTheme, useThemeDef } from '../theme';
import { useT } from '../i18n';
import Icon from './Icon';
import type { IconName } from './Icon';

type Tr = ReturnType<typeof useT>;
const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

export function Chip({ label, color, filled, small }: { label: string; color: string; filled?: boolean; small?: boolean }) {
  const th = useThemeDef();
  return (
    <View style={[{ borderWidth: 1, borderColor: color, paddingHorizontal: small ? 6 : 8, paddingVertical: small ? 1 : 2, backgroundColor: filled ? color : 'transparent' }, { borderRadius: th.r(10) }]}>
      <Text style={{ color: filled ? '#fff' : color, fontSize: small ? 10 : 11, fontWeight: '700' }}>{label}</Text>
    </View>
  );
}

export function PermChips({ perms, small }: { perms: ToolPermission[] | undefined; small?: boolean }) {
  const t = useTheme();
  const tr = useT();
  if (!perms?.length) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>
      {perms.map((p) => <Chip key={p} small={small} label={PERM_LABEL[p] || p} color={permDanger(p) ? t.danger : p === 'network' ? t.warn : t.sub} />)}
    </View>
  );
}

const statusLabel = (tr: Tr, s: ToolCallStatus): string => tr(`tool.status.${s}`);
function statusColor(s: ToolCallStatus, t: Theme): string {
  return s === 'done' ? t.good : s === 'error' ? t.danger : s === 'denied' ? t.danger : s === 'pending' ? t.warn : t.accent;
}

export function fmtDur(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : ms < 10000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

/** One-line summary of the arguments: first string value, else compact JSON. */
export function shortArgs(a: any): string {
  if (a === null || a === undefined) return '';
  if (typeof a === 'string') return a.slice(0, 60);
  if (typeof a === 'object') {
    const vals = Object.values(a);
    if (vals.length === 1 && typeof vals[0] === 'string') return JSON.stringify(vals[0]).slice(0, 60);
    try { return JSON.stringify(a).slice(0, 60); } catch { return ''; }
  }
  return String(a);
}
const prettyJson = (a: any): string => { try { return JSON.stringify(a ?? {}, null, 2); } catch { return String(a); } };

const iconFor = (name: string): IconName => (name === 'web_search' ? 'search' : /fetch|http|url/.test(name) ? 'web' : /time|date|clock/.test(name) ? 'time' : 'tool');

function ToolCard({ call }: { call: ToolCall }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const [open, setOpen] = useState(false);
  const live = call.status === 'running' || call.status === 'pending';
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (call.status !== 'running') return;
    const i = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(i);
  }, [call.status]);
  const col = statusColor(call.status, t);
  const dur = call.durationMs != null ? fmtDur(call.durationMs) : call.status === 'running' && call.startedAt ? fmtDur(Math.max(0, now - call.startedAt)) : '';
  const bad = call.status === 'error' || call.status === 'denied';
  const err = call.error || (bad && !call.result ? (call.status === 'denied' ? tr('tool.deniedByUser') : tr('tool.failed')) : '');
  const args = shortArgs(call.arguments);
  const decided = decidedByLabel(call.decidedBy);
  return (
    <View style={[styles.card, { borderColor: bad ? t.danger : t.border, backgroundColor: t.bg, borderRadius: th.r(10) }]}>
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={tr('tool.cardLabel', { name: call.name, status: statusLabel(tr, call.status) })}
        style={styles.head}
      >
        <Icon name={iconFor(call.name)} size={15} color={t.sub} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ color: t.text, fontSize: 13, fontWeight: '700', fontFamily: MONO }}>{call.name}</Text>
          {!!args && <Text numberOfLines={1} style={{ color: t.sub, fontSize: 11, fontFamily: MONO }}>{args}</Text>}
        </View>
        {call.status === 'running' && <ActivityIndicator size="small" color={t.accentInk} />}
        <Chip label={statusLabel(tr, call.status)} color={col} small />
        {!!dur && <Text style={{ color: t.sub, fontSize: 11 }}>{dur}</Text>}
        <Icon name={open ? 'expand' : 'chevronRight'} size={18} color={t.sub} />
      </Pressable>
      {call.status === 'pending' && !open && <Text style={{ color: t.warn, fontSize: 11, paddingHorizontal: 8, paddingBottom: 6 }}>{tr('tool.waitingApproval')}</Text>}
      {open && (
        <View style={[styles.body, { borderColor: t.border }]}>
          <Text style={[styles.cap, { color: t.sub }]}>{tr('tool.arguments')}</Text>
          <View style={[styles.pre, { backgroundColor: t.code, borderRadius: th.r(6) }]}>
            <Text selectable style={[styles.preText, { color: t.codeText }]}>{prettyJson(call.arguments)}</Text>
          </View>
          {!!decided && <Text style={{ color: t.sub, fontSize: 11, marginTop: 6 }}>{tr(decided.key, decided.params)}</Text>}
          {!!err && (
            <>
              <Text style={[styles.cap, { color: t.danger }]}>{call.status === 'denied' ? tr('tool.denied') : tr('status.error')}</Text>
              <View style={[styles.pre, { backgroundColor: 'transparent', borderWidth: 1, borderColor: t.danger, borderRadius: th.r(6) }]}>
                <Text selectable style={[styles.preText, { color: t.danger }]}>{err}</Text>
              </View>
            </>
          )}
          {call.result !== undefined && call.result !== '' && (
            <>
              <Text style={[styles.cap, { color: t.sub }]}>{tr('tool.result')}</Text>
              <ScrollView nestedScrollEnabled style={[styles.pre, { backgroundColor: t.code, maxHeight: 220, borderRadius: th.r(6) }]}>
                <Text selectable style={[styles.preText, { color: t.codeText }]}>{call.result}</Text>
              </ScrollView>
            </>
          )}
          {live && call.result === undefined && !err && <Text style={{ color: t.sub, fontSize: 12, marginTop: 6 }}>{call.status === 'pending' ? tr('tool.waitingApprovalShort') : tr('tool.running')}</Text>}
        </View>
      )}
    </View>
  );
}

/** Tool-call trace of an assistant message (collapsed rows, expandable). */
export default function ToolCards({ calls }: { calls: ToolCall[] | null | undefined }) {
  if (!calls?.length) return null;
  return <View style={{ gap: 6, marginBottom: 6, minWidth: 250 }}>{calls.map((c) => <ToolCard key={c.id} call={c} />)}</View>;
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 7 },
  body: { borderTopWidth: StyleSheet.hairlineWidth, padding: 8 },
  cap: { fontSize: 11, fontWeight: '700', marginTop: 4, marginBottom: 3 },
  pre: { padding: 8 },
  preText: { fontFamily: MONO, fontSize: 12 },
});
