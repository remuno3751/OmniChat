import React, { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Icon from './Icon';
import { Btn, Label, Sheet, webNoOutline } from '../ui/kit';
import { useT } from '../i18n';
import { activeTemplates, useStore } from '../store';
import { useTheme, useThemeDef } from '../theme';
import { groupBySection, resolveSlashTips, resolveStaticTips } from '../tips/content';
import { highlightParts, latestWhatsNew, searchTips, tipOfTheDay } from '../tips/search';
import { WHATS_NEW } from '../tips/whatsnew';
import type { ResolvedTip, TipAction } from '../tips/types';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** deep link of an entry; called after onClose() */
  onAction: (a: TipAction) => void;
  /** text for the message box; called after onClose() */
  onInsert: (text: string) => void;
  /** project of the active chat (slash entries of its project templates) */
  projectId: string | null;
}

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

/**
 * Tips & help sheet: search, tip of the day, what's new, and the tips grouped by section.
 * Sections and entries start collapsed; while a query is typed every matching one is expanded.
 */
export default function TipsSheet({ visible, onClose, onAction, onInsert, projectId }: Props) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const templates = useStore((s) => s.templates);
  const [q, setQ] = useState('');
  /** explicit open/closed state per section and entry; absent = default (open only while searching) */
  const [secState, setSecState] = useState<Record<string, boolean>>({});
  const [tipState, setTipState] = useState<Record<string, boolean>>({});
  const query = q.trim();
  const searching = query.length > 0;

  useEffect(() => {
    if (!visible) { setQ(''); setSecState({}); setTipState({}); }
  }, [visible]);

  const staticTips = useMemo(() => resolveStaticTips(tr), [tr]);
  const all = useMemo<ResolvedTip[]>(
    () => [...staticTips, ...resolveSlashTips({ templates: activeTemplates(templates), projectId, tr })],
    [staticTips, templates, projectId, tr],
  );
  // tip of the day comes from the static tips only (slash entries change with the user's templates)
  const today = useMemo(() => tipOfTheDay(staticTips.filter((x) => x.section !== 'privacy'), new Date()), [staticTips, visible]);
  const news = useMemo(() => latestWhatsNew(WHATS_NEW, 5), []);
  const groups = useMemo(
    () => groupBySection(searching ? searchTips(all, query) : all),
    [all, searching, query],
  );

  const secOpen = (id: string) => (id in secState ? secState[id] : searching);
  const tipOpen = (key: string) => (key in tipState ? tipState[key] : searching);
  const toggleSec = (id: string) => setSecState((s) => ({ ...s, [id]: !secOpen(id) }));
  const toggleTip = (key: string) => setTipState((s) => ({ ...s, [key]: !tipOpen(key) }));

  const runAction = (a: TipAction) => { onClose(); onAction(a); };
  const runInsert = (text: string) => { onClose(); onInsert(text); };

  // In the Sheet header, so it stays visible while the tips scroll (the Sheet's body is a ScrollView).
  const search = (
    <TextInput
      value={q}
      onChangeText={setQ}
      placeholder={tr('tips.search.placeholder')}
      placeholderTextColor={t.sub}
      accessibilityLabel={tr('tips.search.placeholder')}
      autoCorrect={false}
      autoCapitalize="none"
      style={[styles.search, { color: t.text, backgroundColor: t.input, borderColor: t.border, borderRadius: th.r(10) }, webNoOutline]}
    />
  );

  return (
    <Sheet visible={visible} onClose={onClose} title={tr('tips.title')} width={720} header={search}>
      {!searching && today && (
        <View>
          <Label>{tr('tips.today')}</Label>
          <EntryRow
            tip={today}
            open={tipOpen('today:' + today.id)}
            onToggle={() => toggleTip('today:' + today.id)}
            query=""
            emphasis
            onAction={runAction}
            onInsert={runInsert}
          />
        </View>
      )}
      {!searching && news.length > 0 && (
        <View>
          <Label>{tr('tips.whatsNew')}</Label>
          <View style={[styles.news, { borderColor: t.border, backgroundColor: t.panel2, borderRadius: th.r(10) }]}>
            {news.map((w) => (
              <View key={w.date + w.titleKey} style={{ gap: 2 }}>
                <Text style={{ color: t.sub, fontSize: 11 }}>{w.date}</Text>
                <Text style={{ color: t.text, fontSize: 13, fontWeight: '600' }}>{tr(w.titleKey)}</Text>
                <Text style={{ color: t.sub, fontSize: 12, lineHeight: 17 }}>{tr(w.bodyKey)}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {groups.length === 0 && (
        <Text style={[styles.empty, { color: t.sub }]}>{tr('tips.search.empty', { q: query })}</Text>
      )}
      {groups.map((g) => {
        const open = secOpen(g.section);
        return (
          <View key={g.section} style={{ marginTop: 8 }}>
            <Pressable
              onPress={() => toggleSec(g.section)}
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              style={[styles.secHead, { borderColor: t.border, backgroundColor: t.panel, borderRadius: th.r(10), borderWidth: th.bw }]}
            >
              <Text numberOfLines={1} style={{ flex: 1, color: t.text, fontSize: 14, fontWeight: '700' }}>{tr(`tips.section.${g.section}`)}</Text>
              <Text style={{ color: t.sub, fontSize: 12 }}>{g.tips.length}</Text>
              <Icon name={open ? 'collapse' : 'expand'} size={18} color={t.sub} />
            </Pressable>
            {open && (
              <View style={{ gap: 6, marginTop: 6 }}>
                {g.tips.map((tip) => (
                  <EntryRow
                    key={tip.id}
                    tip={tip}
                    open={tipOpen(tip.id)}
                    onToggle={() => toggleTip(tip.id)}
                    query={query}
                    onAction={runAction}
                    onInsert={runInsert}
                  />
                ))}
              </View>
            )}
          </View>
        );
      })}
    </Sheet>
  );
}

function EntryRow({ tip, open, onToggle, query, emphasis, onAction, onInsert }: {
  tip: ResolvedTip; open: boolean; onToggle: () => void; query: string; emphasis?: boolean;
  onAction: (a: TipAction) => void; onInsert: (text: string) => void;
}) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  return (
    <View style={[styles.entry, { borderColor: emphasis ? t.accent : t.border, backgroundColor: t.panel, borderRadius: th.r(10), borderWidth: th.bw }]}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={styles.entryHead}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Hl text={tip.title} query={query} style={{ color: t.text, fontSize: 15, fontWeight: '600' }} />
        </View>
        <Icon name={open ? 'collapse' : 'chevronRight'} size={18} color={t.sub} />
      </Pressable>
      {open && (
        <View style={styles.entryBody}>
          <Hl text={tip.body} query={query} style={{ color: t.text, fontSize: 14, lineHeight: 20 }} />
          {!!tip.example && (
            <View style={[styles.example, { backgroundColor: t.code, borderRadius: th.r(6) }]}>
              <Text selectable style={{ color: t.codeText, fontFamily: MONO, fontSize: 12, lineHeight: 17 }}>{tip.example}</Text>
            </View>
          )}
          {(!!tip.action || !!tip.insertText) && (
            <View style={styles.actions}>
              {tip.action && (
                <Btn small label={tip.action.label} onPress={() => onAction(tip.action!.action)} />
              )}
              {!!tip.insertText && (
                <Btn small label={tr('tips.insert')} onPress={() => onInsert(tip.insertText!)} />
              )}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

/** Text with the query matches in a highlight background. Plain text when there is no query. */
function Hl({ text, query, style }: { text: string; query: string; style: any }) {
  const t = useTheme();
  if (!query) return <Text style={style}>{text}</Text>;
  return (
    <Text style={style}>
      {highlightParts(text, query).map((p, i) => p.hit
        ? <Text key={i} style={{ backgroundColor: t.accent + '33', color: t.text, fontWeight: '700' }}>{p.text}</Text>
        : <Text key={i}>{p.text}</Text>)}
    </Text>
  );
}

const styles = StyleSheet.create({
  search: { flex: 1, minWidth: 0, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14 },
  news: { borderWidth: 1, padding: 10, gap: 10, marginTop: 4 },
  empty: { fontSize: 13, textAlign: 'center', paddingVertical: 16 },
  secHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  entry: { overflow: 'hidden' },
  entryHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  entryBody: { paddingHorizontal: 12, paddingBottom: 12, gap: 8 },
  example: { padding: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
