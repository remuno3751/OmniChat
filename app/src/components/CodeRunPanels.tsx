import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { AgentRecord, FileChange, Message } from '../protocol';
import { apiV4 } from '../apiV4';
import { useT } from '../i18n';
import { Theme, useTheme, useThemeDef } from '../theme';
import { Sheet } from '../ui/kit';
import { Tag, useFaces } from '../ui/skin';
import { Chip } from './ToolCards';
import DiffView from './DiffView';
import Icon from './Icon';
import type { IconName } from './Icon';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

/** Full-patch lookups per message id (shared by every panel instance); a failed lookup is retried later. */
const fullChanges = new Map<string, Promise<FileChange[]>>();
function loadFullChanges(messageId: string): Promise<FileChange[]> {
  let p = fullChanges.get(messageId);
  if (!p) {
    p = apiV4.messageChanges(messageId).catch((e) => {
      fullChanges.delete(messageId);
      throw e;
    });
    fullChanges.set(messageId, p);
  }
  return p;
}

/** Ticks once a second while `active`; returns the current time for elapsed displays. */
function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [active]);
  return now;
}

/** 1m 23s style. */
function fmtElapsed(ms: number, tr: ReturnType<typeof useT>): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return tr('code.run.elapsedSecs', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return tr('code.run.elapsedMins', { m, s: s % 60 });
  return tr('code.run.elapsedHours', { h: Math.floor(m / 60), m: m % 60 });
}

const LETTER: Record<FileChange['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
function statusColor(s: FileChange['status'], t: Theme): string {
  return s === 'added' ? t.good : s === 'deleted' ? t.danger : s === 'renamed' ? t.accent : t.warn;
}

/** Collapsible section header with a count and optional trailing content. */
function SectionHead({ icon, label, count, extra, open, onToggle, t }: {
  icon: IconName; label: string; count: number; extra?: React.ReactNode; open: boolean; onToggle: () => void; t: Theme;
}) {
  const faces = useFaces();
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={`${label}, ${count}`}
      style={styles.head}
    >
      <Icon name={icon} size={15} color={t.sub} />
      <Text style={[{ color: t.text, fontSize: 13, fontWeight: '700' }, faces.labelBold]}>{label}</Text>
      <Text style={[{ color: t.sub, fontSize: 12 }, faces.num]}>{count}</Text>
      <View style={{ flex: 1 }} />
      {extra}
      <Icon name={open ? 'expand' : 'chevronRight'} size={18} color={t.sub} />
    </Pressable>
  );
}

function ChangeRow({ c, onPress, t }: { c: FileChange; onPress: () => void; t: Theme }) {
  const tr = useT();
  const th = useThemeDef();
  const col = statusColor(c.status, t);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={tr('code.run.changeLabel', { path: c.path, status: tr(`code.run.fileStatus.${c.status}`) })} style={[styles.row, { borderColor: t.border }]}>
      <View style={[styles.badge, { backgroundColor: col + '22', borderRadius: th.r(4) }]}>
        <Text style={{ color: col, fontSize: 11, fontWeight: '800' }}>{LETTER[c.status] ?? '?'}</Text>
      </View>
      <Text numberOfLines={1} ellipsizeMode="middle" style={{ flex: 1, minWidth: 0, color: t.text, fontSize: 12, fontFamily: MONO }}>
        {c.path}
      </Text>
      <Text style={{ color: th.dark ? t.diffAdd : t.good, fontSize: 12, fontFamily: MONO }}>+{c.additions}</Text>
      <Text style={{ color: th.dark ? t.diffDel : t.danger, fontSize: 12, fontFamily: MONO }}>-{c.deletions}</Text>
    </Pressable>
  );
}

/** Diff of one changed file: the inline patch, or the one fetched for the whole message. */
function ChangeDiff({ messageId, change, t }: { messageId: string; change: FileChange; t: Theme }) {
  const tr = useT();
  const themed = useThemeDef().def.id !== 'simple';
  const [st, setSt] = useState<{ state: 'loading' | 'ready' | 'error'; patch?: string | null }>(
    { state: change.patch != null ? 'ready' : 'loading' },
  );
  useEffect(() => {
    if (change.patch != null) return;
    let alive = true;
    setSt({ state: 'loading' });
    loadFullChanges(messageId).then(
      (list) => {
        if (!alive) return;
        const f = list.find((x) => x.path === change.path);
        setSt({ state: 'ready', patch: f?.patch ?? null });
      },
      () => { if (alive) setSt({ state: 'error' }); },
    );
    return () => { alive = false; };
  }, [messageId, change.path, change.patch]);

  if (change.patch == null && st.state === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="small" color={t.accentInk} />
        <Text style={{ color: t.sub, fontSize: 12 }}>{tr('code.loading')}</Text>
      </View>
    );
  }
  if (change.patch == null && st.state === 'error') {
    return <Text style={{ color: t.danger, fontSize: 13, padding: 8 }}>{tr('code.loadError')}</Text>;
  }
  const patch = change.patch ?? st.patch ?? '';
  if (!patch.trim()) return <Text style={{ color: t.sub, fontSize: 13, padding: 8 }}>{tr('code.noPatch')}</Text>;
  return (
    <View>
      {themed ? <Tag style={{ marginBottom: 8 }}>{tr('code.diff')}</Tag> : <Text style={{ color: t.sub, fontSize: 11, fontWeight: '700', marginBottom: 6 }}>{tr('code.diff')}</Text>}
      <DiffView patch={patch} t={t} />
    </View>
  );
}

function AgentRow({ a, now, onPress, t }: { a: AgentRecord; now: number; onPress: () => void; t: Theme }) {
  const tr = useT();
  const th = useThemeDef();
  const col = a.status === 'done' ? t.good : a.status === 'error' ? t.danger : t.accent;
  const elapsed = fmtElapsed((a.endedAt ?? now) - a.startedAt, tr);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${a.role}, ${tr(`status.${a.status}`)}`} style={[styles.row, { borderColor: t.border, alignItems: 'flex-start' }]}>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Text numberOfLines={1} style={{ color: t.text, fontSize: 13, fontWeight: '700', flexShrink: 1 }}>{a.role}</Text>
          {a.status === 'running' ? <ActivityIndicator size="small" color={t.accentInk} /> : null}
          <Chip small label={tr(`status.${a.status}`)} color={col} />
          <Text accessibilityLabel={`${tr('code.elapsed')} ${elapsed}`} style={{ color: t.sub, fontSize: 11, fontFamily: MONO }}>{elapsed}</Text>
        </View>
        {!!a.summary && <Text numberOfLines={2} style={{ color: t.sub, fontSize: 12 }}>{a.summary}</Text>}
      </View>
      <Icon name="chevronRight" size={18} color={t.sub} />
    </Pressable>
  );
}

/** Code-mode run panels under an assistant message: changed files and sub-agents. */
export function CodeRunPanels({ m }: { m: Message }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const changes = m.changes ?? null;
  const agents = m.agents ?? [];
  const anyRunning = agents.some((a) => a.status === 'running');
  const now = useNowTick(anyRunning);
  const [changesOpen, setChangesOpen] = useState(true);
  const [agentsOpen, setAgentsOpen] = useState(agents.length <= 3);
  const [sel, setSel] = useState<FileChange | null>(null);
  const [agentSel, setAgentSel] = useState<AgentRecord | null>(null);

  if (!changes && !agents.length) return null;

  const adds = (changes ?? []).reduce((s, c) => s + (c.additions || 0), 0);
  const dels = (changes ?? []).reduce((s, c) => s + (c.deletions || 0), 0);

  return (
    <View style={{ gap: 6, marginBottom: 6, minWidth: 250 }}>
      {changes && (
        <View style={[styles.panel, { borderColor: t.border, backgroundColor: t.bg, borderRadius: th.r(10) }]}>
          <SectionHead
            icon="folder"
            label={tr('code.changes')}
            count={changes.length}
            open={changesOpen}
            onToggle={() => setChangesOpen(!changesOpen)}
            t={t}
            extra={changes.length ? (
              <View style={{ flexDirection: 'row', gap: 6 }}>
                <Text style={{ color: t.good, fontSize: 12, fontFamily: MONO }}>+{adds}</Text>
                <Text style={{ color: t.danger, fontSize: 12, fontFamily: MONO }}>-{dels}</Text>
              </View>
            ) : null}
          />
          {changesOpen && (changes.length
            ? changes.map((c, i) => <ChangeRow key={`${i}:${c.path}`} c={c} t={t} onPress={() => setSel(c)} />)
            : <Text style={{ color: t.sub, fontSize: 12, paddingHorizontal: 8, paddingBottom: 8 }}>{tr('code.noChanges')}</Text>)}
        </View>
      )}
      {agents.length > 0 && (
        <View style={[styles.panel, { borderColor: t.border, backgroundColor: t.bg, borderRadius: th.r(10) }]}>
          <SectionHead
            icon="agent"
            label={tr('code.agents')}
            count={agents.length}
            open={agentsOpen}
            onToggle={() => setAgentsOpen(!agentsOpen)}
            t={t}
          />
          {agentsOpen && agents.map((a) => <AgentRow key={a.id} a={a} now={now} t={t} onPress={() => setAgentSel(a)} />)}
        </View>
      )}
      <Sheet visible={!!sel} onClose={() => setSel(null)} title={sel?.path}>
        <View style={{ padding: 10 }}>
          {sel && <ChangeDiff messageId={m.id} change={sel} t={t} />}
        </View>
      </Sheet>
      <Sheet visible={!!agentSel} onClose={() => setAgentSel(null)} title={agentSel?.role}>
        <View style={{ padding: 10 }}>
          {agentSel?.log ? (
            <View>
              <Text style={{ color: t.sub, fontSize: 11, fontWeight: '700', marginBottom: 6 }}>{tr('code.log')}</Text>
              <View style={[styles.logBox, { backgroundColor: t.code, borderRadius: th.r(8) }]}>
                <Text selectable style={{ color: t.codeText, fontFamily: MONO, fontSize: 12, lineHeight: 17 }}>{agentSel.log}</Text>
              </View>
            </View>
          ) : (
            <Text style={{ color: t.sub, fontSize: 13 }}>{tr('code.noLog')}</Text>
          )}
        </View>
      </Sheet>
    </View>
  );
}

export default CodeRunPanels;

const styles = StyleSheet.create({
  panel: { borderWidth: 1, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 7 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth },
  badge: { width: 20, height: 18, alignItems: 'center', justifyContent: 'center' },
  center: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 8 },
  logBox: { padding: 10 },
});
