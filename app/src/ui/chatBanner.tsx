import React, { useEffect, useState } from 'react';
import { Animated, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, useThemeDef } from '../theme';
import { useT } from '../i18n';
import { Brackets } from './decor';
import { usePresence } from './skin';
import Icon from '../components/Icon';
import { useInsets } from './safe';

/** "Chat finished" banners at the top of the screen (max 3 stacked, auto-dismiss, tap = open that chat). */
interface Banner { id: number; convId: string; title: string }

const MAX = 3;
const LIFE_MS = 4000;
let list: Banner[] = [];
let nextId = 1;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

/** What the user is looking at; published by App. A banner is shown only for chats that are not in the foreground. */
let foreground: { convId: string | null } = { convId: null };
let opener: ((convId: string) => void) | null = null;
export function setBannerContext(convId: string | null, open: ((convId: string) => void) | null) { foreground = { convId }; opener = open; }
/** Is this conversation the chat currently on screen? (view === 'chat' && active id; null when another screen is shown) */
export const isForeground = (convId: string) => foreground.convId === convId;

export function dismissBanner(id: number) { list = list.filter((b) => b.id !== id); emit(); }

/** Queues a banner for a finished chat; nothing when that chat is in the foreground. One banner per chat (a repeat refreshes it). */
export function showChatDone(convId: string, title: string) {
  if (isForeground(convId)) return;
  const id = nextId++;
  list = [...list.filter((b) => b.convId !== convId), { id, convId, title }].slice(-MAX);
  emit();
  setTimeout(() => dismissBanner(id), LIFE_MS);
}

function BannerItem({ b }: { b: Banner }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const [shown, setShown] = useState(false); // false at mount so the entry animates
  const [out, setOut] = useState(false);
  useEffect(() => { setShown(true); }, []);
  const pres = usePresence(shown && !out, 'base');
  const k = th.mo.distK;
  const ef = th.def.variants.tabs === 'tag';
  const close = () => { setOut(true); setTimeout(() => dismissBanner(b.id), th.dur.fast); };
  const open = () => { opener?.(b.convId); close(); };
  return (
    <Animated.View
      style={{ opacity: pres.v, transform: [{ translateY: pres.v.interpolate({ inputRange: [0, 1], outputRange: [-14 * k, 0] }) }], width: '100%', alignItems: 'center' }}
    >
      <View
        accessibilityRole="alert"
        style={[styles.card, { backgroundColor: t.panel, borderColor: t.borderStrong, borderRadius: th.r(12), borderWidth: th.bw }, ef && { borderLeftWidth: 3, borderLeftColor: t.accentInk }]}
      >
        <Brackets inset={-1} />
        <Pressable
          onPress={open}
          accessibilityRole="button"
          accessibilityLabel={`${tr('banner.done')}: ${b.title}`}
          style={({ hovered }: any) => [styles.main, hovered && { backgroundColor: t.panel2 }]}
        >
          <Icon name="check" size={16} color={t.good} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.sub, fontSize: 11 }} numberOfLines={1}>{tr('banner.done')}</Text>
            <Text style={{ color: t.text, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>{b.title}</Text>
          </View>
        </Pressable>
        <Pressable onPress={close} hitSlop={8} accessibilityRole="button" accessibilityLabel={tr('common.close')} style={styles.x}>
          <Icon name="close" size={16} color={t.sub} />
        </Pressable>
      </View>
    </Animated.View>
  );
}

export function ChatBannerHost() {
  const ins = useInsets();
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    subs.add(f);
    return () => { subs.delete(f); };
  }, []);
  if (!list.length) return null;
  return (
    <View pointerEvents="box-none" style={[styles.wrap, { top: 8 + ins.top, left: 12 + ins.left, right: 12 + ins.right }]}>
      {list.map((b) => <BannerItem key={b.id} b={b} />)}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 8, left: 12, right: 12, alignItems: 'center', gap: 6, zIndex: 1001 },
  card: { flexDirection: 'row', alignItems: 'center', width: '100%', maxWidth: 440, overflow: 'hidden', ...(Platform.OS === 'web' ? ({ boxShadow: '0 4px 16px rgba(0,0,0,0.22)' } as any) : { elevation: 6, shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 8, shadowOffset: { width: 0, height: 3 } }) },
  main: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 9 },
  x: { paddingHorizontal: 12, paddingVertical: 9 },
});
