import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import type { GuardBlockedItem } from '../protocol';
import { useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';
import { guardSourceLabel, truncateExcerpt } from '../searchOptions';

const MAX_ITEMS = 5;

/**
 * Notice under an answer: web content that the prompt-injection guard removed.
 * The excerpts are plain text (never markdown, never links) in a monospace face.
 */
export default function GuardBlockedNotice({ items }: { items?: GuardBlockedItem[] | null }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  if (!items?.length) return null;
  const shown = items.slice(0, MAX_ITEMS);
  const more = items.length - shown.length;
  return (
    <View accessibilityRole="alert" style={[styles.box, { borderColor: t.warn, backgroundColor: t.panel, borderRadius: th.r(8) }]}>
      <Text style={[styles.title, { color: t.warn }]}>{tr('guard.blocked.title')}</Text>
      <Text style={[styles.lead, { color: t.sub }]}>{tr('guard.blocked.lead')}</Text>
      {shown.map((it, i) => (
        <View key={`${it.index}-${i}`} style={[styles.item, { borderColor: t.border }]}>
          <Text style={[styles.source, { color: t.sub }]}>{`[${it.index}] ${guardSourceLabel(it)}`}</Text>
          <Text selectable={false} style={[styles.excerpt, { color: t.codeText, backgroundColor: t.code, borderRadius: th.r(6) }]}>{truncateExcerpt(it.excerpt)}</Text>
        </View>
      ))}
      {more > 0 && <Text style={[styles.lead, { color: t.sub }]}>{tr('guard.blocked.more', { n: more })}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 1, borderStyle: 'dashed', padding: 10, marginTop: 10, gap: 6 },
  title: { fontSize: 13, fontWeight: '700' },
  lead: { fontSize: 12 },
  item: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 6, gap: 3 },
  source: { fontSize: 11, fontWeight: '600' },
  excerpt: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 12, paddingHorizontal: 8, paddingVertical: 6,
  },
});
