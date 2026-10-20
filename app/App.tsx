import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, BackHandler, Platform, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import SidebarShell, { useCanHover } from './src/components/SidebarShell';
import type { SidebarControls } from './src/components/SidebarShell';
import { BACK_PRIORITY } from './src/backHandler';
import { useAndroidBackBridge, useBack } from './src/ui/useBack';
import { Enter, usePresence } from './src/ui/skin';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardAvoid, useInsets } from './src/ui/safe';
import { api, loadConfig, saveAuth, setUnauthorizedHandler, uuid } from './src/api';
import { clearAll, getState, loadCache, markReady, setNotice, useStore } from './src/store';
import type { ChatMode } from './src/protocol';
import { toast } from './src/ui/toast';
import { setDevice, useDeviceSetting } from './src/deviceSettings';
import { CODE_LOCK_PIN_CLEARED, forgetUnlock } from './src/codeLock';
import { AppLockGate, CodeLockGate } from './src/components/CodeLockGate';
import { applyFavicon } from './src/appIcon';
import { resetModelCache } from './src/ModelPicker';
import { setEphemeralDestroyedHandler, setRevokedHandler, startSocket, stopSocket } from './src/socket';
import { isEphemeralId } from './src/ephemeral';
import { endAllEphemeral, endEphemeral, installEphemeralLifecycle, startEphemeralId } from './src/ephemeralActions';
import { useTheme, useThemeDef, useThemeFonts } from './src/theme';
import './src/ui/textPatch';
import { ThemeBackground } from './src/ui/decor';
import LoginScreen from './src/screens/LoginScreen';
import ChatScreen from './src/screens/ChatScreen';
import ConversationList from './src/screens/ConversationList';
import SettingsScreen from './src/screens/SettingsScreen';
import SearchScreen from './src/screens/SearchScreen';
import SessionsScreen from './src/screens/SessionsScreen';
import { startOsNotifications, stopOsNotifications } from './src/notifications';
import { onSearchRequest, setJump, useHistoryAvailable, useProbes, useSearchShortcut } from './src/historyNav';
import { resetAvail } from './src/apiHistory';
import { peekHasPendingDshPair } from './src/dshPairLink';
import type { SettingsPageId } from './src/settingsMeta';
import type { ConnSub } from './src/screens/settings/ConnectionsPage';
import ApprovalHost from './src/components/ApprovalHost';
import DshRelayHost from './src/components/DshRelayHost';
import { clearApprovals, resetToolCaches } from './src/toolState';
import { ConfirmHost, confirmDialog } from './src/ui/confirm';
import { ModelConflictHost } from './src/components/ModelConflictDialog';
import { ToastHost } from './src/ui/toast';
import { ChatBannerHost, setBannerContext } from './src/ui/chatBanner';
import { t as tNow, useT } from './src/i18n';
import TipsSheet from './src/components/TipsSheet';
import UpdatePopup from './src/components/UpdatePopup';
import { requestComposerInsert } from './src/tips/composerBus';
import type { TipAction } from './src/tips/types';

export default function App() {
  return <SafeAreaProvider><AppInner /></SafeAreaProvider>;
}

function AppInner() {
  const t = useTheme();
  const th = useThemeDef();
  const ins = useInsets();
  useThemeFonts();
  const tr = useT();
  const [appIcon] = useDeviceSetting('appIcon');
  useEffect(() => applyFavicon(appIcon), [appIcon]);
  const { width } = useWindowDimensions();
  const wide = width >= 800;
  /** web/desktop with a mouse: the wide sidebar can be pinned or hidden (SidebarShell); other layouts are unchanged */
  const canHover = useCanHover();
  const sidebarShell = Platform.OS === 'web' && wide && canHover;
  const [sidebarPinned, setSidebarPinned] = useDeviceSetting('sidebarPinned');
  const user = useStore((s) => s.user);
  const ready = useStore((s) => s.ready);
  const [booting, setBooting] = useState(true);
  const [view, setView] = useState<'chat' | 'settings' | 'search' | 'sessions'>('chat');
  const [activeId, setActiveId] = useState<string>(() => uuid());
  /** project the (still unsaved) active draft conversation will be created in */
  const [draftProject, setDraftProject] = useState<string | null>(null);
  /** chat / code split: the list shows only this mode; new drafts are created in it */
  const [mode, setMode] = useState<ChatMode>('chat');
  const [drawer, setDrawer] = useState(false);
  /** page the settings screen opens on (set for a DSH pairing link; cleared when settings is left) */
  const [settingsStart, setSettingsStart] = useState<SettingsPageId | null>(null);
  /** sub-entry of settingsStart (Connections > Usage); cleared together with settingsStart */
  const [settingsStartSub, setSettingsStartSub] = useState<ConnSub | null>(null);
  /** Tips & help sheet open */
  const [tipsOpen, setTipsOpen] = useState(false);
  const ephemeralSupported = useStore((s) => s.ephemeralSupported);
  /** project of the active chat (or the draft's project), for the Tips sheet's slash entries */
  const tipsProjectId = useStore((s) => (s.conversations[activeId] ? s.conversations[activeId].projectId ?? null : draftProject));
  /** id of the open chat, readable from callbacks that outlive a render (see dropEphemeral) */
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  /**
   * Leaves the open chat if it is ephemeral: ends it on the server and in memory, then points the view at a fresh
   * normal chat id. A no-op for normal chats. Call it before anything replaces the chat view.
   */
  const dropEphemeral = () => {
    const cur = activeIdRef.current;
    if (!isEphemeralId(cur)) return;
    endEphemeral(cur).catch(() => {});
    activeIdRef.current = uuid();
    setActiveId(activeIdRef.current);
  };
  /** Starts an ephemeral chat (Chat tab; the sidebar button is hidden in Code mode). */
  const newEphemeralChat = () => {
    dropEphemeral();
    setActiveId(startEphemeralId()); setDraftProject(null); setMode('chat'); setView('chat'); setDrawer(false);
  };

  useEffect(() => {
    // web pagehide cleanup of ephemeral chats; on unmount of the app root every live ephemeral chat is ended
    const off = installEphemeralLifecycle();
    return () => { off(); endAllEphemeral().catch(() => {}); };
  }, []);
  useEffect(() => {
    // the server destroyed the open ephemeral chat (idle, ended on another device, logout, limit, ...)
    setEphemeralDestroyedHandler((id) => { if (id === activeIdRef.current) setActiveId(uuid()); });
    return () => setEphemeralDestroyedHandler(null);
  }, []);

  const enter = useCallback(async (a: { userId: string; username: string }) => {
    await loadCache(a);
    setActiveId(uuid());
    setDraftProject(null);
    setView('chat');
    startSocket();
    startOsNotifications();
  }, []);

  useEffect(() => {
    (async () => {
      const a = await loadConfig();
      if (a) await enter(a); else markReady();
      setBooting(false);
    })();
    return () => { stopSocket(); stopOsNotifications(); };
  }, [enter]);

  /** Leaves the session. `remote` also revokes this device's token on the server (best effort). */
  const logout = useCallback(async (remote = true, notice = '') => {
    if (remote) { try { await api.logout(); } catch {} }
    stopSocket();
    stopOsNotifications();
    resetModelCache();
    resetToolCaches();
    clearApprovals();
    await saveAuth(null);
    // the Code lock PIN and the in-memory unlock do not survive a logout (PIN reset path)
    forgetUnlock();
    setDevice({ codeLock: CODE_LOCK_PIN_CLEARED });
    await clearAll();
    setNotice(notice);
    setView('chat');
    setDrawer(false);
  }, []);

  const logoutRef = useRef(logout);
  logoutRef.current = logout;
  useEffect(() => {
    // 4001 on the socket / 401 on a request => this device was revoked
    const revoked = () => logoutRef.current(false, tNow('app.revoked'));
    setRevokedHandler(revoked);
    setUnauthorizedHandler(revoked);
    return () => { setRevokedHandler(null); setUnauthorizedHandler(null); };
  }, []);

  const activeDeleted = useStore((s) => !!s.conversations[activeId]?.deleted);
  // a hook: it must stay above the early returns below (the render before login and the render after it need the same hook order)
  const activeConv = useStore((s) => s.conversations[activeId]);
  useEffect(() => {
    // Another device deleted the conversation we have open: start a fresh chat.
    if (activeDeleted) setActiveId(uuid());
  }, [activeDeleted]);

  const select = (id: string) => {
    if (id !== activeIdRef.current) dropEphemeral();
    const c = getState().conversations[id];
    if (c) setMode(c.mode ?? 'chat');
    setActiveId(id); setDraftProject(null); setView('chat'); setDrawer(false);
  };
  const newChat = (projectId?: string | null) => { dropEphemeral(); setActiveId(uuid()); setDraftProject(projectId ?? null); setView('chat'); setDrawer(false); };
  // Chat / Code tab: a different mode starts a fresh draft unless the active conversation already is that mode
  const changeMode = (next: ChatMode) => {
    setView('chat'); setDrawer(false);
    if (next === mode) return;
    const cur = getState().conversations[activeId];
    setMode(next);
    if (!cur || (cur.mode ?? 'chat') !== next) { dropEphemeral(); setActiveId(uuid()); setDraftProject(null); }
  };
  /** Settings and the other full views replace the chat, so an open ephemeral chat ends there. */
  const openSettings = () => { dropEphemeral(); setView('settings'); setDrawer(false); };
  const openSessions = () => { dropEphemeral(); setView('sessions'); setDrawer(false); };
  /** Settings > Connections > Usage (for the chat's Usage entry). */
  const openUsage = () => { dropEphemeral(); setSettingsStart('connections'); setSettingsStartSub('usage'); setView('settings'); setDrawer(false); };
  /** Settings > Models (the first-run card on an empty chat). */
  const openModels = () => { dropEphemeral(); setSettingsStart('models'); setSettingsStartSub(null); setView('settings'); setDrawer(false); };
  /** A chat picked in the Usage list (same rule as the history search: it must be on this device). */
  const openFromUsage = (id: string) => {
    if (!getState().conversations[id]) { toast(tNow('app.notOnDevice'), 'error'); return; }
    select(id);
  };

  // phase 3: history search (sidebar entry, Settings entry, Ctrl/Cmd+K)
  const histOk = useHistoryAvailable();
  const openSearch = useCallback(() => { dropEphemeral(); setView('search'); setDrawer(false); }, []);
  useProbes(!!user);
  useEffect(() => { if (user) return onSearchRequest(openSearch); }, [user, openSearch]);
  useEffect(() => { if (!user) resetAvail(); }, [user]);
  useSearchShortcut(!!user && histOk, openSearch);

  /** Tips sheet: a deep link from an entry (the sheet has already closed). */
  const onTipAction = (a: TipAction) => {
    if (a.kind === 'settings') { dropEphemeral(); setSettingsStart(a.page); setSettingsStartSub(a.sub ?? null); setView('settings'); setDrawer(false); }
    else if (a.kind === 'search') openSearch();
    else if (a.kind === 'ephemeral') { if (ephemeralSupported) newEphemeralChat(); }
  };
  /** Tips sheet: "Insert into message box" shows the chat and hands the text to its composer. */
  const onTipInsert = (text: string) => { setView('chat'); setDrawer(false); requestComposerInsert(text); };

  // DSH pairing link (#dsh-pair=...): open Settings > Plugins, where the DSH card takes the code.
  useEffect(() => {
    if (user && peekHasPendingDshPair()) {
      setSettingsStart('plugins');
      setSettingsStartSub(null);
      setView('settings');
      setDrawer(false);
    }
  }, [user]);
  const prevView = useRef(view);
  useEffect(() => {
    if (prevView.current === 'settings' && view !== 'settings') { setSettingsStart(null); setSettingsStartSub(null); }
    prevView.current = view;
  }, [view]);

  // chat-finished banners: only for chats that are not on screen; tapping one opens it
  setBannerContext(view === 'chat' ? activeId : null, select);
  const hosts = (<><ToastHost /><ChatBannerHost /><ConfirmHost /><ModelConflictHost />{user && <ApprovalHost />}{user && <DshRelayHost />}{user && <UpdatePopup />}{user && <TipsSheet visible={tipsOpen} onClose={() => setTipsOpen(false)} onAction={onTipAction} onInsert={onTipInsert} projectId={tipsProjectId} />}</>);

  // Android back: the registry runs the topmost open thing first; the ROOT handler asks before exiting.
  useAndroidBackBridge();
  useBack(drawer, BACK_PRIORITY.DRAWER, () => { setDrawer(false); });
  useBack(!!user && view !== 'chat', BACK_PRIORITY.SCREEN, () => { setView('chat'); });
  const exitAsking = useRef(false);
  useBack(true, BACK_PRIORITY.ROOT, () => {
    if (exitAsking.current) return true;
    exitAsking.current = true;
    const generating = Object.values(getState().messages).some((b) => Object.values(b).some((m) => m.status === 'streaming'));
    confirmDialog(tr('app.exit.title'), tr(generating ? 'app.exit.generating' : 'app.exit.message'), tr('app.exit.ok'), false)
      .then((ok) => { if (ok) BackHandler.exitApp(); })
      .finally(() => { exitAsking.current = false; });
    return true;
  });

  const drawerP = usePresence(drawer, 'base');

  if (booting || !ready) {
    return <View style={[styles.center, { backgroundColor: t.bg, paddingTop: ins.top, paddingLeft: ins.left, paddingRight: ins.right }]}><ActivityIndicator color={t.accent} /></View>;
  }
  if (!user) {
    return (
      <KeyboardAvoid useInset style={{ flex: 1, backgroundColor: t.bg, paddingTop: ins.top, paddingLeft: ins.left, paddingRight: ins.right }}>
        <StatusBar style={th.dark ? 'light' : 'dark'} />
        <ThemeBackground />
        <LoginScreen onAuthed={enter} />
        {hosts}
      </KeyboardAvoid>
    );
  }

  const list = (c?: SidebarControls) => (
    <ConversationList
      activeId={activeId}
      onSelect={select}
      onNew={newChat}
      onNewEphemeral={newEphemeralChat}
      onSettings={openSettings}
      mode={mode}
      onMode={changeMode}
      onSessions={openSessions}
      onTips={() => { setTipsOpen(true); setDrawer(false); }}
      pinned={c?.pinned}
      onTogglePin={c?.onTogglePin}
      onHide={c?.onHide}
    />
  );

  /** the Code screens: the sessions list, or a chat in Code mode (a draft counts by the mode toggle) */
  const codeChat = view === 'chat' && (activeConv ? activeConv.mode === 'code' : mode === 'code');

  const main = view === 'settings'
    ? <SettingsScreen onClose={() => setView('chat')} onLogout={() => logout(true)} showBack={!wide} convId={activeId} initialPage={settingsStart ?? undefined} initialSub={settingsStartSub ?? undefined} onOpenChat={openFromUsage} />
    : view === 'sessions'
    ? <CodeLockGate active onLogout={() => logout(true)}><SessionsScreen onBack={() => setView('chat')} onOpen={(id) => select(id)} /></CodeLockGate>
    : view === 'search'
    ? <SearchScreen
        onBack={() => setView('chat')}
        onOpen={(r) => {
          if (!getState().conversations[r.conversationId]) { toast(tNow('app.notOnDevice'), 'error'); return; }
          setJump(r.messageId ? { convId: r.conversationId, messageId: r.messageId } : null);
          select(r.conversationId);
        }}
      />
    : <CodeLockGate active={codeChat} onLogout={() => logout(true)}><ChatScreen convId={activeId} draftProjectId={draftProject} draftMode={mode} showMenu={!wide} onMenu={() => setDrawer(true)} onCreated={() => {}} onSettings={openSettings} onNewChat={() => newChat()} onOpenUsage={openUsage} onOpenModels={openModels} /></CodeLockGate>;

  return (
    <AppLockGate onLogout={() => logout(true)}>
    <KeyboardAvoid useInset style={{ flex: 1, backgroundColor: t.bg, paddingTop: ins.top, paddingLeft: ins.left, paddingRight: ins.right }}>
      <StatusBar style={th.dark ? 'light' : 'dark'} />
      <ThemeBackground />
      <View style={styles.row}>
        {sidebarShell ? (
          <SidebarShell pinned={sidebarPinned} onPinnedChange={setSidebarPinned} renderSidebar={(c) => list(c)}>
            <Enter key={view} style={{ flex: 1 }}>{main}</Enter>
          </SidebarShell>
        ) : (
          <>
            {wide && <View style={{ width: 300 }}>{list()}</View>}
            <View style={{ flex: 1 }}><Enter key={view} style={{ flex: 1 }}>{main}</Enter></View>
          </>
        )}
        {!wide && drawerP.mounted && (
          <View style={[StyleSheet.absoluteFill, { flexDirection: 'row' }]} pointerEvents={drawer ? 'auto' : 'none'}>
            <Animated.View style={{ width: '82%', maxWidth: 340, transform: [{ translateX: drawerP.v.interpolate({ inputRange: [0, 1], outputRange: [-60 * th.mo.distK, 0] }) }], opacity: drawerP.v }}>{list()}</Animated.View>
            <Animated.View style={{ flex: 1, opacity: drawerP.v }}>
              <Pressable style={styles.scrim} onPress={() => setDrawer(false)} accessibilityLabel={tr('app.closeDrawer')} />
            </Animated.View>
          </View>
        )}
      </View>
      {hosts}
    </KeyboardAvoid>
    </AppLockGate>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  row: { flex: 1, flexDirection: 'row' },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
});
