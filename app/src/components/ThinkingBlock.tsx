import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Message } from '../protocol';
import { t as tt, useT } from '../i18n';
import { useTheme } from '../theme';
import { stripMarks, useStreamText } from '../ui/streamText';
import Icon from './Icon';
import { thinkingMs } from '../waitState';

export const fmtSecs = (ms: number) => (ms < 10000 ? tt('msg.secs', { n: (ms / 1000).toFixed(1) }) : ms < 120000 ? tt('msg.secs', { n: Math.round(ms / 1000) }) : tt('msg.minSecs', { m: Math.floor(ms / 60000), s: Math.round((ms % 60000) / 1000) }));

/** Collapsed "Thinking" lane of an assistant message; expandable per message, never mixed into the answer. */
export default function ThinkingBlock({ m }: { m: Message }) {
  const t = useTheme();
  const tr = useT();
  const [open, setOpen] = useState(false);
  const text = m.reasoning || '';
  const streaming = m.status === 'streaming';
  const thinking = streaming && !m.content;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!thinking) return;
    const i = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(i);
  }, [thinking]);
  // the thinking text uses the same streaming animation setting as the answer (hook before any early return)
  const shownText = stripMarks(useStreamText(text, streaming && open));
  if (!text) return null;

  const exact = m.metrics?.reasoningTokens;
  const tokens = exact != null ? tr('msg.think.tokens', { n: exact }) : tr('msg.think.approx', { n: Math.max(1, Math.ceil(text.length / 4)) });
  // from the first reasoning delta (not the request start) to the first answer delta; the wait before the first token is in MetricsLine (TTFT)
  const ms = m.thinkEndedAt || thinking ? thinkingMs(m.thinkStartedAt, m.thinkEndedAt, now) : null;
  const durText = ms != null ? fmtSecs(ms) : '';
  const label = thinking
    ? (durText ? tr('msg.think.thinkingDur', { tokens, dur: durText }) : tr('msg.think.thinkingLabel', { tokens }))
    : (durText ? tr('msg.think.thoughtFor', { dur: durText, tokens }) : tr('msg.think.plain', { tokens }));

  return (
    <View style={[styles.wrap, { borderColor: t.border }]}>
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={open ? tr('msg.think.hide') : tr('msg.think.show')} style={styles.head}>
        <Icon name={open ? 'expand' : 'chevronRight'} size={16} color={t.sub} />
        <Text style={{ color: t.sub, fontSize: 12, fontWeight: '600', flexShrink: 1 }}>{label}</Text>
        {thinking && <ActivityIndicator size="small" color={t.accentInk} style={{ transform: [{ scale: 0.7 }] }} />}
      </Pressable>
      {open && <Text selectable style={[styles.body, { color: t.sub }]}>{(streaming && open ? shownText : text).trim()}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderLeftWidth: 2, paddingLeft: 8, marginBottom: 6 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 },
  body: { fontSize: 13, lineHeight: 19, fontStyle: 'italic', marginTop: 2 },
});
