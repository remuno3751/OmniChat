import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme, useThemeDef } from '../theme';
import { useInsets } from './safe';

type Kind = 'info' | 'error' | 'ok';
interface Toast { id: number; text: string; kind: Kind }

let list: Toast[] = [];
let nextId = 1;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

/** Shows a transient message (works from anywhere, needs <ToastHost/> mounted once). */
export function toast(text: string, kind: Kind = 'info') {
  const id = nextId++;
  list = [...list.slice(-2), { id, text, kind }];
  emit();
  setTimeout(() => { list = list.filter((x) => x.id !== id); emit(); }, kind === 'error' ? 5000 : 3000);
}

export function ToastHost() {
  const t = useTheme();
  const th = useThemeDef();
  const ins = useInsets();
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    subs.add(f);
    return () => { subs.delete(f); };
  }, []);
  if (!list.length) return null;
  return (
    <View pointerEvents="none" style={[styles.wrap, { bottom: 90 + ins.bottom, left: 16 + ins.left, right: 16 + ins.right }]}>
      {list.map((x) => (
        <View
          key={x.id}
          accessibilityRole="alert"
          style={[styles.toast, { backgroundColor: t.panel, borderRadius: th.r(12), borderColor: x.kind === 'error' ? t.danger : x.kind === 'ok' ? t.accentInk : t.border }]}
        >
          <Text style={{ color: x.kind === 'error' ? t.danger : t.text, fontSize: 14 }}>{x.text}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 16, right: 16, bottom: 90, alignItems: 'center', gap: 8, zIndex: 1000 },
  toast: { maxWidth: 520, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 6 },
});
