import React, { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text } from 'react-native';
import { requestSearch, useHistoryAvailable } from '../historyNav';
import type { ExportFormat } from '../historyTypes';
import type { Conversation } from '../protocol';
import { useTheme, useThemeDef } from '../theme';
import { useT } from '../i18n';
import Icon from './Icon';
import type { MenuEntry } from '../ui/kit';
import ExportSheet from './ExportSheet';

/** "Search" row under "+ New chat" in the sidebar (hidden when the server has no history search). */
export function SearchEntry() {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const ok = useHistoryAvailable();
  if (!ok) return null;
  return (
    <Pressable
      onPress={requestSearch}
      accessibilityRole="button"
      accessibilityLabel={tr('list.searchHistory')}
      style={({ hovered }: any) => [styles.row, { borderColor: t.border, borderRadius: th.r(10) }, hovered && { backgroundColor: t.border }]}
    >
      <Icon name="search" size={16} color={t.sub} />
      <Text style={{ color: t.sub, fontSize: 14, flex: 1 }}>{tr('list.searchHistory')}</Text>
      {Platform.OS === 'web' ? <Text style={{ color: t.sub, fontSize: 11 }}>{(globalThis as any).navigator?.platform?.startsWith('Mac') ? '⌘K' : 'Ctrl+K'}</Text> : null}
    </Pressable>
  );
}

/** Conversation menu entries 'Export as Markdown' / 'Export as JSON' + the options dialog. */
export function useExportMenu(menuFor: Conversation | null, v3: boolean) {
  const tr = useT();
  const ok = useHistoryAvailable();
  const [target, setTarget] = useState<{ conv: Conversation; format: ExportFormat } | null>(null);
  const open = (format: ExportFormat) => { const c = menuFor; if (c) setTimeout(() => setTarget({ conv: c, format }), 50); };
  const items: MenuEntry[] = [
    { label: tr('list.exportMarkdown'), hidden: !v3 || !ok, onPress: () => open('md') },
    { label: tr('list.exportJson'), hidden: !v3 || !ok, onPress: () => open('json') },
  ];
  const sheet = <ExportSheet conv={target?.conv ?? null} initialFormat={target?.format ?? 'md'} onClose={() => setTarget(null)} />;
  return { items, sheet };
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 10, marginBottom: 6, paddingVertical: 8, paddingHorizontal: 12, borderWidth: 1 },
});
