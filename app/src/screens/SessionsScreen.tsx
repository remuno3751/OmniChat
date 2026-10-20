import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { apiV4 } from '../apiV4';
import Icon from '../components/Icon';
import { useT } from '../i18n';
import type { CodeSession, CodeStatus } from '../protocol';
import { useStore } from '../store';
import { useTheme, useThemeDef } from '../theme';
import { Btn, ScreenHeader, fmtAgo } from '../ui/kit';

const POLL_MS = 5000;

interface Props {
  onBack: () => void;
  onOpen: (conversationId: string) => void;
}

export default function SessionsScreen({ onBack, onOpen }: Props) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const [sessions, setSessions] = useState<CodeSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);
  const inFlight = useRef(false);

  // codeStatus of the code-mode conversations: a change here triggers an immediate refresh
  const statusKey = useStore((s) => Object.values(s.conversations)
    .filter((c) => (c.mode ?? 'chat') === 'code' && !c.deleted)
    .map((c) => `${c.id}:${c.codeStatus ?? ''}`)
    .join('|'));

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const list = await apiV4.codeSessions();
      if (!alive.current) return;
      setSessions(list);
      setError(null);
    } catch (e: any) {
      if (alive.current) setError(e?.message || tr('sessions.error'));
    } finally {
      inFlight.current = false;
      if (alive.current) { setLoading(false); setNow(Date.now()); }
    }
  }, [tr]);

  useEffect(() => {
    alive.current = true;
    load();
    const id = setInterval(load, POLL_MS);
    return () => { alive.current = false; clearInterval(id); };
  }, [load]);

  useEffect(() => { load(); }, [statusKey, load]);

  const badgeColor = (s: CodeStatus) => {
    switch (s) {
      case 'running': return t.accent;
      case 'awaiting_approval': return t.warn;
      case 'done': return t.good;
      case 'error': return t.danger;
      default: return t.sub;
    }
  };

  const renderRow = (s: CodeSession) => {
    const color = badgeColor(s.codeStatus);
    const label = tr(`status.${s.codeStatus}`);
    const badge = s.codeStatus === 'awaiting_approval' && s.pendingApprovals > 0 ? `${label} (${s.pendingApprovals})` : label;
    return (
      <Pressable
        key={s.conversationId}
        onPress={() => onOpen(s.conversationId)}
        accessibilityRole="button"
        accessibilityLabel={`${s.title}, ${badge}`}
        style={({ hovered }: any) => [styles.row, { borderRadius: th.r(12) }, { borderColor: t.border, backgroundColor: hovered ? t.border : t.panel }]}
      >
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Text numberOfLines={1} style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>{s.title}</Text>
          <Text numberOfLines={1} style={{ color: t.sub, fontSize: 12 }}>{s.cwd}</Text>
          <Text numberOfLines={1} style={{ color: t.sub, fontSize: 12 }}>{`${s.bridge} · ${fmtAgo(s.updatedAt, now)}`}</Text>
        </View>
        <View style={[styles.badge, { borderColor: color }]}>
          <View style={[styles.dot, { backgroundColor: color }]} />
          <Text numberOfLines={1} style={{ color, fontSize: 12, fontWeight: '600' }}>{badge}</Text>
        </View>
      </Pressable>
    );
  };

  let body: React.ReactNode;
  if (loading && sessions.length === 0 && !error) {
    body = (
      <View style={styles.center}>
        <ActivityIndicator color={t.accentInk} />
        <Text style={{ color: t.sub, marginTop: 8 }}>{tr('code.loading')}</Text>
      </View>
    );
  } else if (error && sessions.length === 0) {
    body = (
      <View style={styles.center}>
        <Text style={{ color: t.danger, textAlign: 'center' }}>{error}</Text>
        <View style={{ marginTop: 12 }}>
          <Btn label={tr('common.retry')} onPress={() => { setLoading(true); load(); }} />
        </View>
      </View>
    );
  } else if (sessions.length === 0) {
    body = <Text style={[styles.empty, { color: t.sub }]}>{tr('code.sessionsEmpty')}</Text>;
  } else {
    body = (
      <View style={{ gap: 8 }}>
        {error && (
          <Text style={{ color: t.danger, fontSize: 12 }}>{error}</Text>
        )}
        {sessions.map(renderRow)}
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <ScreenHeader title={tr('code.sessions')} onBack={onBack} />
      <View style={styles.toolbar}>
        <Pressable onPress={() => { setNow(Date.now()); load(); }} hitSlop={8} accessibilityRole="button" accessibilityLabel={tr('common.refresh')}>
          <Icon name="refresh" size={20} color={t.text} />
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.list}>{body}</ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  toolbar: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 16, paddingTop: 10 },
  list: { padding: 16, paddingTop: 10, flexGrow: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 40 },
  empty: { textAlign: 'center', marginTop: 40 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: StyleSheet.hairlineWidth, padding: 12 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4, maxWidth: 150 },
  dot: { width: 7, height: 7, borderRadius: 4 },
});
