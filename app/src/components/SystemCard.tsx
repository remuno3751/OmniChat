import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { SysCard } from '../slashCards';
import { useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';
import { Btn } from '../ui/kit';
import Icon from './Icon';

interface Props {
  card: SysCard;
  onDismiss: () => void;
  /** the card's action button (kind 'openUsage') opens the Usage screen */
  onOpenUsage: () => void;
}

/** A thin horizontal meter; pct is clamped to 0..100. */
function Meter({ pct, color, track }: { pct: number; color: string; track: string }) {
  const p = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  return (
    <View style={[styles.track, { backgroundColor: track }]}>
      <View style={{ width: `${p}%`, height: '100%', backgroundColor: color }} />
    </View>
  );
}

/** Local, non-persisted result of a slash command, shown in the conversation view (never sent to the model). */
export default function SystemCard({ card, onDismiss, onOpenUsage }: Props) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const err = card.tone === 'error';
  const titleColor = err ? t.danger : t.text;

  return (
    <View style={[styles.card, { backgroundColor: t.panel, borderColor: err ? t.danger : t.border, borderRadius: th.r(10) }]}>
      <View style={styles.head}>
        {card.tone === 'busy' && <ActivityIndicator size="small" color={t.accentInk} />}
        <Text style={[styles.title, { color: titleColor }]}>{card.title}</Text>
        <Pressable onPress={onDismiss} hitSlop={8} accessibilityRole="button" accessibilityLabel={tr('slash.card.dismiss')} style={styles.dismiss}>
          <Icon name="close" size={16} color={t.sub} />
        </Pressable>
      </View>
      {card.bar && <Meter pct={card.bar.pct} color={card.bar.warn ? t.danger : t.accent} track={t.border} />}
      {card.lines.map((line, i) => (
        <Text key={i} style={[styles.line, { color: t.sub }]}>{line}</Text>
      ))}
      {!!card.rows && card.rows.length > 0 && (
        <View style={styles.rows}>
          {!!card.rowsTitle && <Text style={[styles.rowsTitle, { color: t.sub }]}>{card.rowsTitle}</Text>}
          {card.rows.map((r, i) => (
            <View key={i} style={styles.rowWrap}>
              <View style={styles.row}>
                <Text numberOfLines={1} style={[styles.rowLabel, { color: t.text }]}>{r.label}</Text>
                {!!r.value && <Text numberOfLines={1} style={[styles.rowValue, { color: t.sub }]}>{r.value}</Text>}
              </View>
              {r.pct !== undefined && <Meter pct={r.pct} color={t.accent2} track={t.border} />}
            </View>
          ))}
        </View>
      )}
      {card.action && (
        <View style={styles.actionRow}>
          <Btn small label={card.action.label} onPress={onOpenUsage} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 6, width: '100%' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, fontSize: 14, fontWeight: '700' },
  dismiss: { padding: 2 },
  line: { fontSize: 13, lineHeight: 18 },
  track: { height: 4, borderRadius: 2, overflow: 'hidden', width: '100%' },
  rows: { gap: 6, marginTop: 4 },
  rowsTitle: { fontSize: 12, fontWeight: '600' },
  rowWrap: { gap: 3 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  rowLabel: { flexShrink: 1, fontSize: 13 },
  rowValue: { fontSize: 12 },
  actionRow: { flexDirection: 'row', marginTop: 4 },
});
