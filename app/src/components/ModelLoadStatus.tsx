import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import type { ModelLoadProgress } from '../modelLoad';
import { useProgress } from '../modelLoadState';
import { useT } from '../i18n';
import { useTheme } from '../theme';

const isActive = (p: ModelLoadProgress | null, conversationId: string): p is ModelLoadProgress =>
  !!p && p.conversationId === conversationId && (p.phase === 'unloading' || p.phase === 'loading');

/** True while a model unload/load runs for this conversation (holds the send button). */
export function useModelLoadBusy(conversationId: string): boolean {
  return isActive(useProgress(), conversationId);
}

/** Slim status line above the composer: "Unloading X..." / "Loading Y...". Renders nothing otherwise. */
export function ModelLoadStatus({ conversationId }: { conversationId: string }) {
  const p = useProgress();
  const t = useTheme();
  const tr = useT();
  if (!isActive(p, conversationId)) return null;
  const unloading = p.phase === 'unloading' ? (p.unloading ?? []) : [];
  const text = unloading.length
    ? tr('modelload.status.unloading', { names: unloading.join(', ') })
    : tr('modelload.status.loading', { name: p.model });
  return (
    <View style={styles.wrap} accessibilityLiveRegion="polite">
      <ActivityIndicator size="small" color={t.accent} />
      <Text style={{ color: t.sub, fontSize: 12, flexShrink: 1 }} numberOfLines={2}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 6 },
});
