import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { switchBranch } from '../chatActions';
import { setJump, useJump } from '../historyNav';
import type { Message } from '../protocol';
import { useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';
import Icon from './Icon';
import type { Tree } from '../tree';

/**
 * "Jump to message" for the chat list (used after opening a search result).
 * - wrap(id, node): wraps a message row so it can be measured and highlighted
 * - active: a jump for this conversation is pending (disables the automatic scroll to the end)
 * - banner: shown when the message exists but is on another branch (offers a switch) or is missing locally
 */
export function useMessageJump(o: { convId: string; path: Message[]; tree: Tree; scroller: React.RefObject<ScrollView | null> }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const j = useJump();
  const active = !!j && j.convId === o.convId;
  const target = active ? j!.messageId : null;
  const ys = useRef(new Map<string, number>());
  const [tick, setTick] = useState(0);
  const [hl, setHl] = useState<string | null>(null);
  const done = useRef<string | null>(null);
  // keep the position after the jump ended (no scroll-to-end) until the conversation or its last message changes
  const hold = useRef<{ convId: string; head: string } | null>(null);
  const head = o.path.length ? o.path[o.path.length - 1].id : '';
  if (hold.current && (hold.current.convId !== o.convId || hold.current.head !== head)) hold.current = null;
  if (active) hold.current = { convId: o.convId, head };

  const onPath = !!target && o.path.some((m) => m.id === target);
  const known = !!target && o.tree.byId.has(target);

  useEffect(() => {
    if (!target || !onPath) return;
    const y = ys.current.get(target);
    if (y === undefined) return;
    const key = `${j!.ts}:${target}`;
    if (done.current === key) return;
    done.current = key;
    // re-read the latest measured y: rows above may still be settling right after mount
    const go = () => { const yy = ys.current.get(target); if (yy !== undefined) o.scroller.current?.scrollTo({ y: Math.max(0, yy - 24), animated: false }); };
    go();
    setTimeout(go, 120);
    setTimeout(go, 400);
    setHl(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, onPath, tick, o.path.length]);

  useEffect(() => {
    if (!hl) return;
    const off = setTimeout(() => { setHl(null); setJump(null); }, 3500);
    return () => clearTimeout(off);
  }, [hl]);

  const wrap = useCallback((id: string, node: React.ReactNode) => (
    <View
      key={id}
      onLayout={(e) => { const y = e.nativeEvent.layout.y; if (ys.current.get(id) !== y) { ys.current.set(id, y); if (id === target) setTick((n) => n + 1); } }}
      style={hl === id ? { backgroundColor: t.warn + '33', borderRadius: th.r(12) } : undefined}
    >
      {node}
    </View>
  ), [hl, t.warn, target]);

  let banner: React.ReactNode = null;
  if (target && !onPath && known) {
    banner = (
      <Pressable accessibilityRole="button" onPress={() => { switchBranch(o.convId, o.tree, target); }} style={{ backgroundColor: t.panel, borderBottomWidth: 1, borderColor: t.warn, paddingHorizontal: 14, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Text style={{ color: t.text, flex: 1, fontSize: 13 }}>{tr('msg.jump.otherBranch')}</Text>
        <Text style={{ color: t.accentInk, fontWeight: '700', fontSize: 13 }}>{tr('msg.jump.switch')}</Text>
        <Pressable onPress={() => setJump(null)} accessibilityLabel={tr('msg.jump.dismiss')} hitSlop={8}><Icon name="close" size={18} color={t.sub} /></Pressable>
      </Pressable>
    );
  } else if (target && !known && o.tree.list.length > 0) {
    banner = (
      <Pressable onPress={() => setJump(null)} style={{ backgroundColor: t.panel, borderBottomWidth: 1, borderColor: t.border, paddingHorizontal: 14, paddingVertical: 10 }}>
        <Text style={{ color: t.sub, fontSize: 13 }}>{tr('msg.jump.notOnDevice')}</Text>
      </Pressable>
    );
  }
  return { wrap, active: active || !!hold.current, banner };
}
