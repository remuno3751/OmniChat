import React, { useEffect, useMemo, useState } from 'react';
import { splitFooterItems } from '../sidebarFooter';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { api } from '../api';
import { isEphemeralId } from '../ephemeral';
import { isPinned, setPinned } from '../chatActions';
import Icon from '../components/Icon';
import ProjectSheet from '../components/ProjectSheet';
import type { ChatMode, Conversation } from '../protocol';
import { useT } from '../i18n';
import { activeProjects, activeProviders, applyUpsert, sortedConversations, toggleCollapsed, useStore } from '../store';
import { setDevice, useDevice } from '../deviceSettings';
import { useBridges } from '../useBridges';
import { codeDevices } from '../codeWorkspace';
import { deviceOf, groupByDevice, groupByWorkspace, type CodeGroup } from '../codeGroups';
import { needsUnlock } from '../components/CodeLockGate';
import { subscribeForget } from '../codeLock';
import { useTheme, useThemeDef } from '../theme';
import { confirmDialog } from '../ui/confirm';
import { MenuSheet, useV3 } from '../ui/kit';
import type { MenuEntry } from '../ui/kit';
import { toast } from '../ui/toast';
import { SearchEntry, useExportMenu } from '../components/SidebarExtras';
import { Barcode, Enter, NotifyBadge, tx, useFaces } from '../ui/skin';

interface Props {
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: (projectId?: string | null) => void;
  /** starts an ephemeral chat (Chat tab only; the button is hidden in Code mode) */
  onNewEphemeral?: () => void;
  onSettings: () => void;
  /** Chat / Code tab: only conversations and projects of this mode are listed */
  mode: ChatMode;
  onMode: (m: ChatMode) => void;
  /** Code mode only: opens the sessions overview */
  onSessions?: () => void;
  /** opens the Tips & help sheet */
  onTips?: () => void;
  /** wide web layout only: pin state and the pin / hide buttons (omitted = no buttons) */
  pinned?: boolean;
  onTogglePin?: () => void;
  onHide?: () => void;
}

export default function ConversationList({ activeId, onSelect, onNew, onNewEphemeral, onSettings, mode, onMode, onSessions, onTips, pinned, onTogglePin, onHide }: Props) {
  const t = useTheme();
  const th = useThemeDef();
  const themed = th.def.id !== 'simple';
  const tabsV = th.def.variants.tabs;
  const pillBtn = th.def.variants.button === 'pill' || th.def.shape.radius?.pill === 999 && th.def.id === 'frontier';
  const tr = useT();
  const v3 = useV3();
  const convs = useStore((s) => s.conversations);
  const projectsMap = useStore((s) => s.projects);
  const collapsed = useStore((s) => s.collapsed);
  const connected = useStore((s) => s.connected);
  const user = useStore((s) => s.user);
  const ephemeralSupported = useStore((s) => s.ephemeralSupported);
  // ephemeral chats are never listed: they are reachable only as the open chat
  const all = useMemo(() => sortedConversations(convs).filter((c) => (c.mode ?? 'chat') === mode && !c.ephemeral && !isEphemeralId(c.id)), [convs, mode]);
  // pinned chats form their own group at the top (newest pin first); the rest keep the usual order
  const pinnedList = useMemo(() => all.filter(isPinned).sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)), [all]);
  const list = useMemo(() => all.filter((c) => !isPinned(c)), [all]);
  const projects = useMemo(() => activeProjects(projectsMap).filter((p) => (p.mode ?? 'chat') === mode), [projectsMap, mode]);
  const visibleProjectIds = useMemo(() => new Set(projects.map((p) => p.id)), [projects]);
  const [menuFor, setMenuFor] = useState<Conversation | null>(null);
  const [moveFor, setMoveFor] = useState<Conversation | null>(null);
  const [sheet, setSheet] = useState<{ projectId: string | null } | null>(null);
  const [footW, setFootW] = useState(280);
  const exp = useExportMenu(menuFor, v3);
  const faces = useFaces();
  // a Code session waits for approval: badge on the Code tab while the Chat tab is open (themes only)
  const codeWaiting = useMemo(() => Object.values(convs).some((c) => !c.deleted && c.mode === 'code' && c.codeStatus === 'awaiting_approval'), [convs]);

  // Code: group by workspace (working folder); with several PCs a device badge, optionally device first (docs/design/CODE-WORKSPACES.md)
  const providersMap = useStore((s) => s.providers);
  const bridges = useBridges(mode === 'code');
  // While the Code lock is engaged the Code chat titles (and folder names) stay hidden until it is unlocked.
  const lockRule = useDevice((s) => s.codeLock);
  const [codeHidden, setCodeHidden] = useState(() => mode === 'code' && needsUnlock());
  useEffect(() => {
    const check = () => setCodeHidden(mode === 'code' && needsUnlock());
    check();
    const off = subscribeForget(check);
    const id = setInterval(check, 3000);
    return () => { off(); clearInterval(id); };
  }, [mode, lockRule]);
  const byDeviceSetting = useDevice((s) => s.codeGroupByDevice);
  const devices = useMemo(() => codeDevices(activeProviders(providersMap), bridges), [providersMap, bridges]);
  const multiDevice = mode === 'code' && devices.length > 1;
  const byDevice = multiDevice && byDeviceSetting;
  /** online state of a bridge: true / false, or null while /bridges is unknown (old server) */
  const bridgeOnline = (name: string | null): boolean | null => (name === null || bridges === null ? null : bridges.some((b) => b.name === name && b.online));

  const groups = useMemo(() => {
    const byProject = new Map<string, Conversation[]>();
    const loose: Conversation[] = [];
    for (const c of list) {
      if (v3 && c.projectId && visibleProjectIds.has(c.projectId)) {
        const a = byProject.get(c.projectId) || [];
        a.push(c);
        byProject.set(c.projectId, a);
      } else loose.push(c);
    }
    return { byProject, loose };
  }, [list, visibleProjectIds, v3]);

  const togglePin = async (c: Conversation) => {
    try { await setPinned(c.id, !isPinned(c)); } catch (e: any) { toast(e.message || tr('chat.pinFailed'), 'error'); }
  };

  const del = async (c: Conversation) => {
    if (!(await confirmDialog(tr('list.deleteTitle'), tr('list.deleteMsg', { title: c.title }), tr('common.delete')))) return;
    try {
      applyUpsert({ conversations: [await api.deleteConversation(c.id)] });
    } catch (e: any) { toast(e.message || tr('list.deleteFailed'), 'error'); }
    if (c.id === activeId) onNew();
  };
  const move = async (c: Conversation, projectId: string | null) => {
    try {
      applyUpsert({ conversations: [await api.putConversation(c.id, { projectId })] });
    } catch (e: any) { toast(e.message || tr('list.moveFailed'), 'error'); }
  };

  const deviceBadge = (name: string) => {
    const on = bridgeOnline(name);
    return (
      <View style={styles.badge} accessibilityLabel={`${name}${on === null ? '' : ' ' + tr(on ? 'code.device.online' : 'code.device.offline')}`}>
        <View style={[styles.badgeDot, { backgroundColor: on ? t.accent : t.border }]} />
        <Text numberOfLines={1} style={{ color: t.sub, fontSize: 10, maxWidth: 70 }}>{name}</Text>
      </View>
    );
  };
  const rowDevice = (c: Conversation): string | null => {
    if (!multiDevice || byDevice || c.mode !== 'code') return null;
    return deviceOf(c, providersMap);
  };
  const row = (c: Conversation, indent: boolean) => (
    <Enter key={c.id} skip={Date.now() - c.createdAt > 4000}><Pressable
      key={c.id}
      onPress={() => onSelect(c.id)}
      onLongPress={() => setMenuFor(c)}
      delayLongPress={350}
      accessibilityRole="button"
      style={({ hovered }: any) => [
        styles.row, tx(th), { borderRadius: th.r(8) }, indent && { paddingLeft: 26 },
        themed && { borderLeftWidth: 3, borderLeftColor: c.id === activeId ? (tabsV === 'tag' ? t.accent : t.accent2) : 'transparent', paddingLeft: indent ? 23 : 11 },
        (c.id === activeId || hovered) && { backgroundColor: themed ? t.panel2 : t.border },
      ]}
    >
      {mode === 'code' && statusColor(c.codeStatus, t) && <View style={[styles.dot, { backgroundColor: statusColor(c.codeStatus, t) ?? t.sub }]} />}
      <Text numberOfLines={1} style={[styles.rowText, { color: t.text }]}>{c.title}</Text>
      {rowDevice(c) !== null && deviceBadge(rowDevice(c)!)}
      <Pressable onPress={() => setMenuFor(c)} hitSlop={8} accessibilityLabel={tr('list.conversationMenu')}>
        <Icon name="more" size={18} color={t.sub} />
      </Pressable>
    </Pressable></Enter>
  );

  const header = (key: string, name: string, count: number, projectId: string | null, path?: string | null, extra?: React.ReactNode, depth = 0, folder = false) => (
    <View key={'h' + key} style={[styles.groupHead, depth > 0 && { paddingLeft: 12 + 14 * depth }]}>
      <Pressable
        style={styles.groupToggle}
        onPress={() => toggleCollapsed(key)}
        onLongPress={path ? () => toast(path) : undefined}
        accessibilityRole="button"
        accessibilityState={{ expanded: !collapsed[key] }}
        accessibilityLabel={tr('list.groupLabel', { name })}
        {...(path ? ({ title: path } as any) : {})}
      >
        <Icon name={collapsed[key] ? 'chevronRight' : 'expand'} size={16} color={t.sub} />
        {folder && <Icon name="folder" size={15} color={t.sub} />}
        <Text numberOfLines={1} style={[styles.groupName, { color: t.sub }, faces.labelBold, themed && { fontSize: 11 }]}>{name}</Text>
        <Text style={[{ color: t.sub, fontSize: 12 }, faces.num]}>{count}</Text>
        {extra}
      </Pressable>
      {projectId !== null && (
        <>
          <Pressable onPress={() => onNew(projectId)} hitSlop={8} accessibilityLabel={tr('list.newChatIn', { name })}><Icon name="add" size={20} color={t.text} /></Pressable>
          <Pressable onPress={() => setSheet({ projectId })} hitSlop={8} accessibilityLabel={tr('list.projectSettings', { name })}><Icon name="more" size={18} color={t.sub} /></Pressable>
        </>
      )}
    </View>
  );

  const moveItems: MenuEntry[] = moveFor
    ? [
        ...(moveFor.projectId ? [{ label: tr('list.unclassified'), onPress: () => move(moveFor, null) }] : []),
        ...projects.filter((p) => p.id !== moveFor.projectId).map((p) => ({ label: p.name, onPress: () => move(moveFor, p.id) })),
      ]
    : [];

  /** icon-only bottom button; the tooltip (web) and accessibilityLabel carry the text */
  const iconBtn = (name: 'newProject' | 'newChat' | 'ephemeral' | 'settings' | 'history' | 'tips' | 'pin' | 'openPanel', label: string, onPress: () => void) => (
    <Pressable
      key={name}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ hovered }: any) => [styles.iconBtn, { borderRadius: pillBtn ? 18 : th.r(8) }, themed && { borderWidth: th.bw, borderColor: t.border }, hovered && { backgroundColor: themed ? t.panel2 : t.border }]}
      {...({ title: label } as any)}
    >
      <Icon name={name} size={20} color={t.text} />
    </Pressable>
  );

  // footer icons in display order; the low-priority ones move to the top row (beside the user name) when the sidebar is narrow
  const footerItems: { key: string; prio: number; node: React.ReactNode }[] = [];
  if (v3) footerItems.push({ key: 'newProject', prio: 2, node: iconBtn('newProject', tr('sidebar.newProject'), () => setSheet({ projectId: null })) });
  if (mode === 'code' && onSessions) footerItems.push({ key: 'history', prio: 3, node: iconBtn('history', tr('code.sessions'), onSessions) });
  footerItems.push({ key: 'newChat', prio: 1, node: iconBtn('newChat', tr('sidebar.newChat'), () => onNew()) });
  if (ephemeralSupported && mode === 'chat' && onNewEphemeral) footerItems.push({ key: 'ephemeral', prio: 4, node: iconBtn('ephemeral', tr('eph.newChat'), onNewEphemeral) });
  if (onTips) footerItems.push({ key: 'tips', prio: 5, node: iconBtn('tips', tr('tips.button.a11y'), onTips) });
  if (onTogglePin) footerItems.push({ key: 'pin', prio: 7, node: iconBtn('pin', tr(pinned ? 'sidebar.unpin' : 'sidebar.pin'), onTogglePin) });
  if (onHide) footerItems.push({ key: 'hide', prio: 6, node: iconBtn('openPanel', tr('sidebar.hide'), onHide) });
  footerItems.push({ key: 'settings', prio: 0, node: iconBtn('settings', tr('sidebar.settings'), onSettings) });
  const footer = splitFooterItems(footerItems, footW);

  const showUncl = v3 && projects.length > 0 && groups.loose.length > 0;
  const wsGroup = (g: CodeGroup, depth: number) => (
    <View key={g.key}>
      {header(g.key, g.path ? g.label : tr('code.ws.other'), g.convs.length, null, g.path, !multiDevice && devices.length === 1 && deviceOf(g.convs[0], providersMap) ? deviceBadge(deviceOf(g.convs[0], providersMap)!) : undefined, depth, true)}
      {!collapsed[g.key] && g.convs.map((c) => row(c, true))}
    </View>
  );
  const codeLoose = (): React.ReactNode => {
    const toggle = multiDevice ? (
      <Pressable key="bydev" onPress={() => setDevice({ codeGroupByDevice: !byDeviceSetting })} accessibilityRole="checkbox" accessibilityState={{ checked: byDevice }} style={styles.toggleRow}>
        <Icon name={byDevice ? 'check' : 'add'} size={14} color={t.sub} />
        <Text style={{ color: t.sub, fontSize: 12 }}>{tr('code.groupByDevice')}</Text>
      </Pressable>
    ) : null;
    if (byDevice) {
      return [toggle, ...groupByDevice(groups.loose, providersMap).map((d) => {
        const on = bridgeOnline(d.device);
        const name = d.device ?? tr('code.ws.other');
        const count = d.groups.reduce((n, g) => n + g.convs.length, 0);
        return (
          <View key={d.key}>
            {header(d.key, name, count, null, null, d.device ? <View style={[styles.badgeDot, { backgroundColor: on ? t.accent : t.border }]} accessibilityLabel={tr(on ? 'code.device.online' : 'code.device.offline')} /> : undefined)}
            {!collapsed[d.key] && d.groups.map((g) => wsGroup(g, 1))}
          </View>
        );
      })];
    }
    return [toggle, ...groupByWorkspace(groups.loose, providersMap, multiDevice).map((g) => wsGroup(g, 0))];
  };
  return (
    <View style={[styles.root, { backgroundColor: t.panel, borderColor: t.border }]}>
      {tabsV === 'tag' && th.fx && (
        <View style={styles.plate} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <View style={{ width: 8, height: 8, backgroundColor: th.dark ? t.accent : t.accent2, borderWidth: th.dark ? 0 : 1, borderColor: t.text }} />
          <Text style={[{ color: t.text, fontSize: 11, fontWeight: '700' }, faces.headingBold, { letterSpacing: 2 }]}>OMNICHAT</Text>
          <View style={{ flex: 1, height: 1, backgroundColor: t.border }} />
          <Barcode width={40} height={9} color={t.sub} />
        </View>
      )}
      <View style={[styles.tabs, { borderColor: tabsV === 'folder' ? t.borderStrong : t.border, borderRadius: th.r(10) }, tabsV === 'folder' && styles.folderBar, tabsV === 'tag' && th.fx && { marginTop: 4 }]}>
        {(['chat', 'code'] as const).map((m) => {
          const on = mode === m;
          const label = tr(`sidebar.mode.${m}`);
          const folder = tabsV === 'folder';
          return (
            <Pressable
              key={m}
              onPress={() => onMode(m)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={label}
              style={[
                styles.tab,
                tx(th),
                on && tabsV === 'segment' && { backgroundColor: t.border, borderBottomColor: t.accent },
                on && tabsV === 'tag' && { backgroundColor: t.text, borderBottomColor: t.accent2 },
                // Astral notebook tab: the selected tab takes the list's colour and opens into it
                folder && { borderTopLeftRadius: th.r(12), borderTopRightRadius: th.r(12), borderWidth: 1, borderBottomWidth: 1, borderColor: 'transparent', backgroundColor: th.dark ? 'rgba(0,0,0,0.22)' : 'rgba(86,78,69,0.08)', marginTop: 4 },
                on && folder && { backgroundColor: t.panel, borderColor: t.borderStrong, borderBottomColor: t.panel, marginTop: 0, marginBottom: -1, paddingBottom: 13 },
              ]}
            >
              {on && folder && <View style={[styles.folderMark, { backgroundColor: t.accent2 }]} />}
              <Icon name={m === 'chat' ? 'modeChat' : 'modeCode'} size={16} color={on ? (tabsV === 'tag' ? t.bg : t.text) : t.sub} />
              <Text style={[{ color: on ? (tabsV === 'tag' ? t.bg : t.text) : t.sub, fontWeight: on ? '700' : '500', fontSize: 14, textTransform: th.def.fonts.labelCaps ? 'uppercase' : undefined, letterSpacing: th.def.fonts.labelCaps ? 1 : undefined }, on ? faces.labelBold : faces.label]}>{label}</Text>
              {m === 'code' && mode !== 'code' && codeWaiting && <NotifyBadge top={4} right={6} label={tr('list.codeWaiting')} />}
            </Pressable>
          );
        })}
      </View>
      {v3 && !codeHidden && <SearchEntry />}
      {codeHidden ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 }}>
          <Icon name="lock" size={22} color={t.sub} />
          <Text style={{ color: t.sub, fontSize: 13, textAlign: 'center' }}>{tr('code.list.locked')}</Text>
        </View>
      ) : (
      <ScrollView style={{ flex: 1 }}>
        {all.length === 0 && projects.length === 0 && <Text style={[styles.empty, { color: t.sub }]}>{tr('list.empty')}</Text>}
        {pinnedList.length > 0 && (
          <View>
            {header('pinned', tr('list.pinned'), pinnedList.length, null)}
            {!collapsed['pinned'] && pinnedList.map((c) => row(c, false))}
          </View>
        )}
        {projects.map((p) => {
          const items = groups.byProject.get(p.id) || [];
          return (
            <View key={p.id}>
              {header(p.id, p.name, items.length, p.id)}
              {!collapsed[p.id] && items.map((c) => row(c, true))}
              {!collapsed[p.id] && items.length === 0 && <Text style={{ color: t.sub, fontSize: 12, paddingLeft: 26, paddingVertical: 4 }}>{tr('list.emptyProject')}</Text>}
            </View>
          );
        })}
        {showUncl && header('', tr('list.unclassified'), groups.loose.length, null)}
        {(!showUncl || !collapsed['']) && (mode === 'code' ? codeLoose() : groups.loose.map((c) => row(c, showUncl)))}
      </ScrollView>
      )}
      <View style={[styles.footer, { borderColor: t.border }]} onLayout={(e) => setFootW(Math.round(e.nativeEvent.layout.width) - 20)}>
        <View style={styles.footRow}>
          <View style={styles.userWrap}>
            <View style={[styles.dot, { backgroundColor: connected ? t.accent : t.danger }]} />
            <Text numberOfLines={1} style={{ color: t.sub, fontSize: 13, flexShrink: 1 }}>{user?.username ?? ''}</Text>
          </View>
          {footer.top.map((i) => i.node)}
        </View>
        <View style={[styles.footRow, { justifyContent: 'flex-end', flexWrap: 'wrap' }]}>
          {footer.bottom.map((i) => i.node)}
        </View>
      </View>
      <MenuSheet
        visible={!!menuFor}
        onClose={() => setMenuFor(null)}
        title={menuFor?.title}
        items={[
          { label: menuFor && isPinned(menuFor) ? tr('list.unpin') : tr('list.pin'), onPress: () => menuFor && togglePin(menuFor) },
          { label: tr('list.moveToProject'), hidden: !v3 || (projects.length === 0), onPress: () => { const c = menuFor; setTimeout(() => setMoveFor(c), 50); } },
          ...exp.items,
          { label: tr('common.delete'), danger: true, onPress: () => menuFor && del(menuFor) },
        ]}
      />
      <MenuSheet visible={!!moveFor} onClose={() => setMoveFor(null)} title={tr('list.moveTo')} items={moveItems} />
      {exp.sheet}
      <ProjectSheet visible={!!sheet} projectId={sheet?.projectId ?? null} onClose={() => setSheet(null)} mode={mode} />
    </View>
  );
}

/** Dot colour for the Code-mode status of a conversation (null = no dot). */
function statusColor(s: Conversation['codeStatus'], t: { accent: string; warn: string; danger: string }): string | null {
  if (s === 'running') return t.accent;
  if (s === 'awaiting_approval') return t.warn;
  if (s === 'error') return t.danger;
  return null;
}

const styles = StyleSheet.create({
  root: { flex: 1, borderRightWidth: StyleSheet.hairlineWidth },
  tabs: { flexDirection: 'row', margin: 10, borderWidth: 1, overflow: 'hidden' },
  plate: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 12, marginTop: 12 },
  folderBar: { borderWidth: 0, borderBottomWidth: 1, borderRadius: 0, gap: 4, overflow: 'visible', marginBottom: 6, paddingHorizontal: 4 },
  folderMark: { position: 'absolute', top: -1, left: 14, right: 14, height: 2, borderRadius: 1 },
  tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 9, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 2 },
  groupToggle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4 },
  groupName: { flexShrink: 1, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  hbtn: { fontSize: 18, paddingHorizontal: 4 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 11, marginHorizontal: 6, gap: 8 },
  rowText: { flex: 1, fontSize: 15 },
  empty: { textAlign: 'center', marginTop: 24 },
  footer: { gap: 4, paddingHorizontal: 10, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth },
  footRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  userWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
  iconBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  badgeDot: { width: 6, height: 6, borderRadius: 3 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingTop: 8 },
});
