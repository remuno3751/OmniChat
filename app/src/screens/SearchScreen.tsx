import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError } from '../api';
import { apiHistory, setAvail } from '../apiHistory';
import { isEphemeralId } from '../ephemeral';
import { addRecent, clearRecent, loadRecent } from '../historyNav';
import { fmtDate, parseSnippet } from '../historyTypes';
import type { HistoryResult } from '../historyTypes';
import { useT } from '../i18n';
import { activeProjects, useStore } from '../store';
import { useTheme, useThemeDef } from '../theme';
import Icon from '../components/Icon';
import { Btn, ScreenHeader, webNoOutline } from '../ui/kit';

const PAGE = 20;

/** Renders a snippet with the \u0001..\u0002 hit as highlighted <Text> spans (no HTML). */
export function Snippet({ text, lines = 3 }: { text: string; lines?: number }) {
  const t = useTheme();
  const parts = useMemo(() => parseSnippet(text), [text]);
  return (
    <Text numberOfLines={lines} style={{ color: t.text, fontSize: 14, lineHeight: 20 }}>
      {parts.map((p, i) => p.hit
        ? <Text key={i} style={{ backgroundColor: t.warn + '55', color: t.text, fontWeight: '700' }}>{p.text}</Text>
        : <Text key={i}>{p.text}</Text>)}
    </Text>
  );
}

export default function SearchScreen({ onBack, onOpen }: { onBack: () => void; onOpen: (r: HistoryResult) => void }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const projectsMap = useStore((s) => s.projects);
  const projects = useMemo(() => activeProjects(projectsMap), [projectsMap]);
  const [q, setQ] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [results, setResults] = useState<HistoryResult[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [done, setDone] = useState(false); // a search for the current query finished
  const [recent, setRecent] = useState<string[]>([]);
  const seq = useRef(0);

  useEffect(() => { loadRecent().then(setRecent); }, []);

  const run = useCallback(async (query: string, pid: string | null, offset: number) => {
    const my = ++seq.current;
    if (offset === 0) setLoading(true); else setMore(true);
    setErr('');
    try {
      const r = await apiHistory.search(query, pid, offset, PAGE);
      if (my !== seq.current) return;
      // ephemeral chats never appear in history (the server excludes them too; this is a client-side guard)
      const list = Array.isArray(r?.results) ? r.results.filter((x: HistoryResult) => !isEphemeralId(x.conversationId)) : [];
      setResults((prev) => (offset === 0 ? list : [...prev, ...list]));
      setTotal(typeof r?.total === 'number' ? r.total : list.length);
      setDone(true);
    } catch (e: any) {
      if (my !== seq.current) return;
      if (e instanceof ApiError && e.status === 404) { setUnavailable(true); setAvail('history', 'no'); }
      else setErr(e?.message || tr('search.failed'));
      if (offset === 0) { setResults([]); setTotal(0); setDone(false); }
    } finally {
      if (my === seq.current) { setLoading(false); setMore(false); }
    }
  }, [tr]);

  // debounce 300 ms
  useEffect(() => {
    const query = q.trim();
    if (!query) { seq.current++; setResults([]); setTotal(0); setLoading(false); setDone(false); setErr(''); return; }
    const h = setTimeout(() => run(query, projectId, 0), 300);
    return () => clearTimeout(h);
  }, [q, projectId, run]);

  const open = async (r: HistoryResult) => {
    setRecent(await addRecent(q));
    onOpen(r);
  };
  const submit = async () => { if (q.trim()) { setRecent(await addRecent(q)); run(q.trim(), projectId, 0); } };
  const hasMore = results.length < total;
  const projName = (id: string | null) => (id && projectsMap[id] && !projectsMap[id].deleted ? projectsMap[id].name : '');

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <ScreenHeader title={tr('list.searchHistory')} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <TextInput
          value={q}
          onChangeText={setQ}
          onSubmitEditing={submit}
          placeholder={tr('search.placeholder')}
          placeholderTextColor={t.sub}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel={tr('list.searchHistory')}
          style={[styles.input, { borderRadius: th.r(10) }, { color: t.text, borderColor: t.border, backgroundColor: t.input }, webNoOutline]}
        />
        {projects.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            {[{ id: null as string | null, name: tr('search.allProjects') }, ...projects.map((p) => ({ id: p.id as string | null, name: p.name }))].map((p) => {
              const on = p.id === projectId;
              return (
                <Pressable key={p.id ?? 'all'} onPress={() => setProjectId(p.id)} accessibilityRole="button" accessibilityState={{ selected: on }}
                  style={[styles.chip, { borderRadius: th.r(16) }, { borderColor: on ? t.accent : t.border, backgroundColor: on ? t.accent : 'transparent' }]}>
                  <Text numberOfLines={1} style={{ color: on ? t.accentText : t.text, fontSize: 13, fontWeight: '600' }}>{p.name}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}

        {unavailable && <Text style={{ color: t.sub, marginTop: 16 }}>{tr('search.unavailable')}</Text>}

        {!unavailable && !q.trim() && (
          <View style={{ marginTop: 14 }}>
            {recent.length > 0 ? (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Text style={{ color: t.sub, fontSize: 12, flex: 1, fontWeight: '700', textTransform: 'uppercase' }}>{tr('search.recent')}</Text>
                  <Btn small label={tr('tools.clear')} onPress={async () => { await clearRecent(); setRecent([]); }} />
                </View>
                {recent.map((r) => (
                  <Pressable key={r} onPress={() => setQ(r)} accessibilityRole="button" style={({ hovered }: any) => [styles.recent, { borderRadius: th.r(8) }, hovered && { backgroundColor: t.panel }]}>
                    <Icon name="refresh" size={14} color={t.sub} />
                    <Text numberOfLines={1} style={{ color: t.text, flex: 1 }}>{r}</Text>
                  </Pressable>
                ))}
              </>
            ) : (
              <Text style={{ color: t.sub }}>{tr('search.hint')}</Text>
            )}
          </View>
        )}

        {loading && <ActivityIndicator color={t.accentInk} style={{ marginTop: 20 }} />}
        {!!err && (
          <View style={{ marginTop: 16, gap: 8 }}>
            <Text style={{ color: t.danger }}>{err}</Text>
            <Btn small label={tr('common.retry')} onPress={() => run(q.trim(), projectId, results.length)} />
          </View>
        )}
        {done && !loading && !err && !unavailable && results.length === 0 && q.trim() !== '' && (
          <Text style={{ color: t.sub, marginTop: 20, textAlign: 'center' }}>{tr('search.noResults', { q: q.trim() })}</Text>
        )}
        {results.length > 0 && (
          <Text style={{ color: t.sub, fontSize: 12, marginTop: 12 }}>
            {total === 1 ? tr('search.resultOne', { n: total }) : tr('search.resultMany', { n: total })}
          </Text>
        )}
        {results.map((r, i) => (
          <Pressable
            key={`${r.conversationId}:${r.messageId ?? 'title'}:${i}`}
            onPress={() => open(r)}
            accessibilityRole="button"
            accessibilityLabel={tr('search.openLabel', { title: r.conversationTitle })}
            style={({ hovered }: any) => [styles.card, { borderRadius: th.r(12) }, { borderColor: t.border, backgroundColor: hovered ? t.border : t.panel }]}
          >
            <View style={styles.meta}>
              <Text numberOfLines={1} style={{ color: t.text, fontWeight: '700', fontSize: 15, flexShrink: 1 }}>{r.conversationTitle || tr('search.untitled')}</Text>
              {r.messageId === null
                ? <Text style={[styles.badge, { borderRadius: th.r(8) }, { color: t.accentInk, borderColor: t.accent }]}>{tr('search.badgeTitle')}</Text>
                : <Text style={[styles.badge, { borderRadius: th.r(8) }, { color: t.sub, borderColor: t.border }]}>{r.role === 'assistant' ? tr('search.roleAssistant') : tr('search.roleYou')}</Text>}
            </View>
            <Snippet text={r.snippet} />
            <Text numberOfLines={1} style={{ color: t.sub, fontSize: 11, marginTop: 4 }}>
              {fmtDate(r.createdAt)}{projName(r.projectId) ? ` · ${projName(r.projectId)}` : ''}
            </Text>
          </Pressable>
        ))}
        {hasMore && !loading && (
          <View style={{ marginTop: 10, alignItems: 'center' }}>
            {more ? <ActivityIndicator color={t.accentInk} /> : <Btn label={tr('search.loadMore')} onPress={() => run(q.trim(), projectId, results.length)} />}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { padding: 16, width: '100%', maxWidth: 720, alignSelf: 'center', paddingBottom: 40 },
  input: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  chips: { gap: 6, paddingTop: 10, paddingBottom: 2 },
  chip: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 6, maxWidth: 200 },
  recent: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 6 },
  card: { borderWidth: 1, padding: 12, marginTop: 8 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  badge: { fontSize: 11, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 1, overflow: 'hidden' },
});
