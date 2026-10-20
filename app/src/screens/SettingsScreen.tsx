import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Icon from '../components/Icon';
import { useT } from '../i18n';
import { SETTINGS_META, SETTINGS_PAGES } from '../settingsMeta';
import type { SettingsPageId } from '../settingsMeta';
import { useStore } from '../store';
import { useServerAdminAvailable } from '../apiAdmin';
import { useTheme, useThemeDef } from '../theme';
import { THEMES } from '../themes';
import { FourStar } from '../ui/decor';
import { useFaces } from '../ui/skin';
import { Btn, useV3, useWide, webNoOutline } from '../ui/kit';
import AppearancePage from './settings/AppearancePage';
import ChatPage from './settings/ChatPage';
import CodePage from './settings/CodePage';
import ConnectionsPage from './settings/ConnectionsPage';
import type { ConnSub } from './settings/ConnectionsPage';
import DeveloperPage from './settings/DeveloperPage';
import GeneralPage from './settings/GeneralPage';
import ModelsPage from './settings/ModelsPage';
import PluginsPage from './settings/PluginsPage';
import UpdatesPage from './settings/UpdatesPage';
import { useUpdateBadge } from '../updateStore';
import ServerPage from './settings/ServerPage';
import ThisChatPage from './settings/ThisChatPage';
import { EmbeddedContext } from './settings/common';
import { BACK_PRIORITY } from '../backHandler';
import { useBack } from '../ui/useBack';

/** 'this' = the open chat's settings; otherwise a settings page. */
type Page = 'this' | SettingsPageId;
/** The selected page; `n` bumps on every selection so the shown page remounts. */
type Sel = { page: Page; sub?: ConnSub; n: number };

/** Sub-entries under Connections (wide layout and search only). */
const CONN_SUBS: { key: ConnSub; titleKey: string }[] = [
  { key: 'stats', titleKey: 'settings.statistics' },
  { key: 'devices', titleKey: 'settings.devices' },
  { key: 'apikeys', titleKey: 'settings.apiKeys' },
  { key: 'usage', titleKey: 'settings.usage' },
];

/**
 * Settings. Narrow: a list (with search) that opens a page full screen with a back arrow.
 * Wide (>= 700): a master-detail split, the list on the left and the selected page on the right.
 */
export default function SettingsScreen({ onClose, onLogout, showBack, convId, initialPage, initialSub, onOpenChat }: {
  onClose: () => void; onLogout: () => void; showBack: boolean; convId: string | null;
  /** page to open first (read on mount only) */
  initialPage?: SettingsPageId;
  /** sub-entry of initialPage (Connections), read on mount only */
  initialSub?: ConnSub;
  /** opens a chat from the Usage list */
  onOpenChat?: (id: string) => void;
}) {
  const t = useTheme();
  const th = useThemeDef();
  const faces = useFaces();
  const tr = useT();
  const wide = useWide();
  const v3 = useV3();
  const serverAdmin = useServerAdminAvailable();
  const updBadge = useUpdateBadge();
  const chatExists = useStore((s) => !!convId && !!s.conversations[convId]);
  const [sel, setSel] = useState<Sel | null>(() => (initialPage ? { page: initialPage, sub: initialSub, n: 0 } : null));
  const [query, setQuery] = useState('');

  const go = (page: Page, sub?: ConnSub) => setSel((p) => ({ page, sub, n: (p?.n ?? 0) + 1 }));
  // Wide: the first available item is selected by default. 'This chat' falls back to General when no chat is open.
  let cur: Sel | null = sel ?? (wide ? { page: chatExists ? 'this' : 'general', n: 0 } : null);
  if (cur?.page === 'this' && !chatExists) cur = { page: 'general', n: cur.n };
  const back = () => setSel(null);
  // narrow: an open page goes back to the list (then the App's SCREEN handler leaves settings)
  useBack(!wide && sel !== null, BACK_PRIORITY.SUBPAGE, () => { setSel(null); });

  const q = query.trim().toLowerCase();
  const hit = (s: string) => s.toLowerCase().includes(q);

  const rows: { key: Page; title: string; hint?: string; disabled: boolean }[] = [
    { key: 'this', title: tr('settings.thisChat'), hint: chatExists ? undefined : tr('settings.thisChat.disabled'), disabled: !chatExists },
    ...SETTINGS_PAGES.flatMap((p) => [
      // Server admin sits right before Developer (after Connections), only for admins on a capable server.
      ...(p.id === 'developer' && serverAdmin ? [{ key: 'server' as Page, title: tr('settings.page.server'), disabled: false }] : []),
      { key: p.id as Page, title: tr(p.titleKey), disabled: false },
    ]),
  ];

  const badgeDot = (key: Page) => key === 'updates' && updBadge
    ? <View accessibilityLabel={tr('settings.page.updates.badge')} style={[styles.dot, { backgroundColor: t.accent }]} />
    : null;

  const items = rows.map((r) => {
    const titleHit = !q || hit(r.title);
    const matched = q && r.key !== 'this'
      ? Object.values(SETTINGS_META).filter((m) => m.page === r.key).map((m) => tr(m.labelKey)).filter(hit)
      : [];
    const subs = r.key === 'connections' && v3 ? CONN_SUBS.map((s) => ({ key: s.key, title: tr(s.titleKey) })) : [];
    const subHits = q ? subs.filter((s) => hit(s.title)) : subs;
    const subsShown = titleHit ? subs : subHits;
    const visible = !q || titleHit || matched.length > 0 || subHits.length > 0;
    return { ...r, visible, subLine: matched.length ? matched[0] : r.hint, subsShown };
  }).filter((r) => r.visible);

  const isSel = (key: Page, sub?: ConnSub) => !!cur && cur.page === key && cur.sub === sub;

  const searchField = (
    <TextInput
      value={query}
      onChangeText={setQuery}
      placeholder={tr('settings.search')}
      placeholderTextColor={t.sub}
      accessibilityLabel={tr('settings.search')}
      autoCorrect={false}
      autoCapitalize="none"
      style={[styles.search, { color: t.text, backgroundColor: t.panel, borderColor: t.border, borderRadius: th.r(10) }, webNoOutline]}
    />
  );
  const emptyText = items.length === 0 ? <Text style={[styles.empty, { color: t.sub }]}>{tr('settings.noResults')}</Text> : null;

  const ef = th.def.variants.tabs === 'tag';
  const astralLook = th.def.variants.tabs === 'folder';
  // Narrow: the page takes the whole screen, as before.
  if (!wide && cur) return renderPage(cur, back);

  const accentBar = <View style={[styles.accentBar, { backgroundColor: th.def.id === 'simple' ? t.accent : ef ? t.accent : t.accent2, borderRadius: th.r(2) }, th.def.id !== 'simple' && { width: 4, top: 0, bottom: 0 }, astralLook && { width: 6, backgroundColor: t.accent, borderRadius: 0 }]} />;
  // Astral: the selected entry is a cream card with a yellow block (quest list); dark text on it in both modes
  const selFace = astralLook ? THEMES.astral.modes.light.panel : null;

  if (!wide) {
    return (
      <View style={[styles.root, { backgroundColor: 'transparent' }]}>
        <View style={[styles.header, { borderColor: t.border }]}>
          {showBack && <Pressable onPress={onClose} hitSlop={8} accessibilityLabel={tr('common.back')}><Icon name="back" size={22} color={t.text} /></Pressable>}
          <Text style={[styles.title, { color: t.text }]}>{tr('settings.title')}</Text>
          {!showBack && <Btn label={tr('common.close')} onPress={onClose} />}
        </View>
        <ScrollView contentContainerStyle={styles.body}>
          {searchField}
          {items.map((r, idx) => (
            <Pressable
              key={r.key}
              onPress={() => go(r.key)}
              disabled={r.disabled}
              accessibilityRole="button"
              accessibilityState={{ disabled: r.disabled }}
              style={[styles.row, { borderColor: t.border, backgroundColor: t.panel, borderRadius: th.r(12), opacity: r.disabled ? 0.45 : 1 }]}
            >
              {ef && <Text style={[{ color: t.sub, fontSize: 11, width: 22 }, faces.num]}>{String(idx + 1).padStart(2, '0')}</Text>}
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>{r.title}</Text>
                {!!r.subLine && <Text style={{ color: t.sub, fontSize: 12, marginTop: 2 }}>{r.subLine}</Text>}
              </View>
              {badgeDot(r.key)}
              <Icon name="chevronRight" size={20} color={t.sub} />
            </Pressable>
          ))}
          {emptyText}
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: 'transparent' }]}>
      <View style={[styles.header, { borderColor: t.border }]}>
        <Text style={[styles.title, { color: t.text }]}>{tr('settings.title')}</Text>
        <Btn label={tr('common.close')} onPress={onClose} />
      </View>
      <View style={styles.split}>
        <View style={[styles.left, { borderColor: t.border }]}>
          <View style={styles.leftSearch}>{searchField}</View>
          <ScrollView contentContainerStyle={styles.leftBody}>
            {items.map((r, idx) => {
              const on = isSel(r.key);
              return (
                <React.Fragment key={r.key}>
                  <Pressable
                    onPress={() => go(r.key)}
                    disabled={r.disabled}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: r.disabled, selected: on }}
                    style={({ hovered }: any) => [styles.wideRow, th.def.id !== 'simple' && { marginHorizontal: 8, marginVertical: 1, borderRadius: th.r(6), overflow: 'hidden' }, !on && hovered && th.def.id !== 'simple' && { backgroundColor: t.panel2 }, on && { backgroundColor: selFace ?? (th.def.id === 'simple' ? t.border : t.panel2) }, { opacity: r.disabled ? 0.45 : 1 }]}
                  >
                    {on && accentBar}
                    {ef && <Text style={[{ color: on ? t.text : t.sub, fontSize: 11, width: 24 }, faces.num]}>{String(idx + 1).padStart(2, '0')}</Text>}
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: on && selFace ? '#2a2827' : t.text, fontSize: 15, fontWeight: on ? '700' : '600' }}>{r.title}</Text>
                      {!!r.subLine && <Text style={{ color: on && selFace ? '#6b5d4c' : t.sub, fontSize: 12, marginTop: 2 }}>{r.subLine}</Text>}
                    </View>
                    {badgeDot(r.key)}
                    {on && astralLook && th.fx && <FourStar size={11} color="#c99a1a" />}
                  </Pressable>
                  {r.subsShown.map((s) => {
                    const subOn = isSel('connections', s.key);
                    return (
                      <Pressable
                        key={s.key}
                        onPress={() => go('connections', s.key)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: subOn }}
                        style={[styles.subRow, subOn && { backgroundColor: th.def.id === 'simple' ? t.border : t.panel2 }, th.def.id !== 'simple' && { marginHorizontal: 8, borderRadius: th.r(6), overflow: 'hidden' }]}
                      >
                        {subOn && accentBar}
                        <Text style={{ color: subOn ? t.text : t.sub, fontSize: 14, fontWeight: subOn ? '600' : '400' }}>{s.title}</Text>
                      </Pressable>
                    );
                  })}
                </React.Fragment>
              );
            })}
            {emptyText}
          </ScrollView>
        </View>
        <View style={styles.right}>
          {cur && (
            <EmbeddedContext.Provider value>
              <View key={cur.n} style={{ flex: 1 }}>{renderPage(cur, back)}</View>
            </EmbeddedContext.Provider>
          )}
        </View>
      </View>
    </View>
  );

  function renderPage(c: Sel, onBack: () => void) {
    switch (c.page) {
      case 'this': return <ThisChatPage convId={convId} onBack={onBack} />;
      case 'general': return <GeneralPage onBack={onBack} onLogout={onLogout} />;
      case 'appearance': return <AppearancePage onBack={onBack} />;
      case 'models': return <ModelsPage onBack={onBack} />;
      case 'chat': return <ChatPage onBack={onBack} />;
      case 'code': return <CodePage onBack={onBack} onLogout={onLogout} />;
      case 'plugins': return <PluginsPage onBack={onBack} onGoto={(p) => go(p)} />;
      case 'updates': return <UpdatesPage onBack={onBack} />;
      case 'connections': return <ConnectionsPage key={c.n} initialSub={c.sub} onBack={onBack} onLogout={onLogout} onOpenChat={onOpenChat} />;
      case 'server': return <ServerPage onBack={onBack} />;
      case 'developer': return <DeveloperPage onBack={onBack} />;
      default: return null;
    }
  }
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { flex: 1, fontSize: 18, fontWeight: '600' },
  body: { padding: 16, gap: 10, width: '100%', maxWidth: 720, alignSelf: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 14 },
  search: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14 },
  empty: { fontSize: 13, textAlign: 'center', paddingVertical: 16 },
  split: { flex: 1, flexDirection: 'row' },
  left: { width: 280, borderRightWidth: StyleSheet.hairlineWidth },
  leftSearch: { padding: 12 },
  leftBody: { paddingBottom: 16 },
  right: { flex: 1 },
  wideRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingLeft: 16, paddingRight: 12 },
  subRow: { paddingVertical: 8, paddingLeft: 36, paddingRight: 12 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  accentBar: { position: 'absolute', left: 0, top: 6, bottom: 6, width: 3, borderRadius: 2 },
});
