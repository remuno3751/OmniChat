import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';
import { usePresence } from '../ui/skin';
import Icon from './Icon';
import {
  PEEK_CLOSE_DELAY_MS,
  PEEK_HOT_DELAY_MS,
  initialSidebarState,
  reduceSidebar,
  sidebarHotZoneActive,
  sidebarInLayout,
  sidebarOverlayShown,
} from './sidebarMachine';
import type { SidebarEvent, SidebarState } from './sidebarMachine';

/** width of the sidebar in the wide layout (matches the fixed column it replaces) */
export const SIDEBAR_WIDTH = 300;
/** px at the left edge of the window that peeks the hidden sidebar on hover */
const HOT_ZONE_WIDTH = 12;

/** true on web when the primary pointer can hover (mouse, trackpad); false on phones and touch-only devices */
export function useCanHover(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const mm = (globalThis as any).matchMedia;
    if (typeof mm !== 'function') return;
    const q = mm('(hover: hover) and (pointer: fine)');
    const set = () => setOk(!!q.matches);
    set();
    if (q.addEventListener) q.addEventListener('change', set);
    else if (q.addListener) q.addListener(set);
    return () => {
      if (q.removeEventListener) q.removeEventListener('change', set);
      else if (q.removeListener) q.removeListener(set);
    };
  }, []);
  return ok;
}

export interface SidebarControls {
  /** pinned = the sidebar keeps its place in the layout */
  pinned: boolean;
  /** hides the sidebar (or shows it again when it is hidden) */
  onHide: () => void;
  onTogglePin: () => void;
}

interface Props {
  /** the persisted pin setting (device settings) */
  pinned: boolean;
  onPinnedChange: (pinned: boolean) => void;
  /** builds the sidebar content; rendered exactly once */
  renderSidebar: (c: SidebarControls) => React.ReactNode;
  children: React.ReactNode;
}

/**
 * Collapsible left sidebar for the wide web/desktop layout. Pinned: the sidebar takes layout space.
 * Unpinned: it is hidden; a hover at the left edge slides it in as an overlay that does not move the content.
 * Ctrl/Cmd+B toggles the pin. Use only where useCanHover() is true; native and narrow layouts keep their own.
 */
export default function SidebarShell({ pinned, onPinnedChange, renderSidebar, children }: Props) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const [state, setState] = useState<SidebarState>(() => initialSidebarState(pinned));
  const stateRef = useRef(state);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinnedCb = useRef(onPinnedChange);
  pinnedCb.current = onPinnedChange;

  const cancelTimer = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);

  const send = useCallback((e: SidebarEvent): void => {
    const r = reduceSidebar(stateRef.current, e);
    if (r.state !== stateRef.current) { stateRef.current = r.state; setState(r.state); }
    if (r.effect === 'cancelClose') cancelTimer();
    else if (r.effect === 'scheduleClose' || r.effect === 'scheduleHotClose') {
      cancelTimer();
      timer.current = setTimeout(() => { timer.current = null; send({ type: 'closeTimer' }); }, r.effect === 'scheduleHotClose' ? PEEK_HOT_DELAY_MS : PEEK_CLOSE_DELAY_MS);
    }
  }, [cancelTimer]);

  useEffect(() => cancelTimer, [cancelTimer]);

  // the persisted setting may load after mount, or change elsewhere: follow it (a no-op when it already matches)
  useEffect(() => { send({ type: 'pin', pinned }); }, [pinned, send]);

  const togglePin = useCallback(() => {
    const next = !stateRef.current.pinned;
    send({ type: 'pin', pinned: next });
    pinnedCb.current(next);
  }, [send]);
  const hide = useCallback(() => send({ type: 'toggle' }), [send]);

  // Ctrl/Cmd+B pins / unpins the sidebar (web only)
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const doc: any = (globalThis as any).document;
    if (!doc?.addEventListener) return;
    const h = (e: any) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && String(e.key).toLowerCase() === 'b') {
        e.preventDefault();
        togglePin();
      }
    };
    doc.addEventListener('keydown', h);
    return () => doc.removeEventListener('keydown', h);
  }, [togglePin]);

  const inLayout = sidebarInLayout(state);
  const hot = sidebarHotZoneActive(state);
  const overlay = sidebarOverlayShown(state);
  const visible = inLayout || overlay;

  // layout share: 0 = out of the layout, 1 = takes SIDEBAR_WIDTH (animated; instant when motion is off)
  const layoutV = useRef(new Animated.Value(inLayout ? 1 : 0)).current;
  useEffect(() => {
    const [a, b, c, d] = th.ease;
    if (!th.dur.base) { layoutV.setValue(inLayout ? 1 : 0); return; }
    Animated.timing(layoutV, { toValue: inLayout ? 1 : 0, duration: th.dur.base, easing: Easing.bezier(a, b, c, d), useNativeDriver: false }).start();
  }, [inLayout]);
  // overlay share: 0..1 slide of the peek / explicit show (usePresence keeps the exit animation)
  const overlayP = usePresence(overlay, 'base').v;

  const spacerWidth = layoutV.interpolate({ inputRange: [0, 1], outputRange: [0, SIDEBAR_WIDTH] });
  const translateX = Animated.add(layoutV, overlayP).interpolate({
    inputRange: [0, 1], outputRange: [-SIDEBAR_WIDTH, 0], extrapolate: 'clamp',
  });

  const hoverPanel = Platform.OS === 'web'
    ? ({ onMouseEnter: () => send({ type: 'panelEnter' }), onMouseLeave: () => send({ type: 'panelLeave' }) } as any)
    : {};
  const hoverHot = Platform.OS === 'web'
    ? ({ onMouseEnter: () => send({ type: 'hotEnter' }) } as any)
    : {};

  return (
    <View style={styles.row}>
      {/* keeps the content beside the sidebar while it is pinned */}
      <Animated.View style={{ width: spacerWidth }} />
      <View style={styles.main}>{children}</View>
      {hot && <View style={styles.hot} {...hoverHot} />}
      <Animated.View
        pointerEvents={visible ? 'auto' : 'none'}
        style={[
          styles.panel,
          { backgroundColor: t.bg, borderRightColor: t.border },
          !inLayout && styles.overlay,
          { transform: [{ translateX }] },
        ]}
        {...hoverPanel}
      >
        {renderSidebar({ pinned: state.pinned, onHide: hide, onTogglePin: togglePin })}
      </Animated.View>
      {hot && (
        <Pressable
          onPress={hide}
          accessibilityRole="button"
          accessibilityLabel={tr('sidebar.show')}
          hitSlop={6}
          style={({ hovered }: any) => [styles.showBtn, { backgroundColor: hovered ? t.border : t.panel2, borderColor: t.border }]}
          {...({ title: tr('sidebar.show') } as any)}
        >
          <Icon name="openPanel" size={20} color={t.text} />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row' },
  main: { flex: 1, minWidth: 0 },
  panel: {
    position: 'absolute', left: 0, top: 0, bottom: 0, width: SIDEBAR_WIDTH, zIndex: 20,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  overlay: {
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 4, height: 0 }, elevation: 8,
  },
  hot: { position: 'absolute', left: 0, top: 0, bottom: 0, width: HOT_ZONE_WIDTH, zIndex: 10 },
  showBtn: {
    // an edge tab at mid-height: the top-left corner is taken by the chat header
    position: 'absolute', left: 0, top: '45%', zIndex: 15, width: 28, height: 48, borderTopRightRadius: 10, borderBottomRightRadius: 10,
    alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth,
  },
});
