import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Metrics } from '../protocol';
import { t, useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';

export const fmtTps = (v: number | null | undefined) => (v == null ? '-' : v >= 100 ? `${Math.round(v)}` : v.toFixed(1));
export const fmtMs = (v: number | null | undefined) => (v == null ? '-' : v >= 10000 ? `${(v / 1000).toFixed(1)} ${t('unit.sec')}` : `${Math.round(v)} ms`);

/** One-line speed summary under an assistant reply (TTFT, prefill / decode tok/s, tokens, 'est.' badge). */
export default function MetricsLine({ metrics, onPress }: { metrics: Metrics | null | undefined; onPress?: () => void }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  if (!metrics) return null;
  const parts: string[] = [];
  if (metrics.ttftMs != null) parts.push(tr('msg.metrics.ttft', { v: fmtMs(metrics.ttftMs) }));
  if (metrics.prefillTps != null) parts.push(tr('msg.metrics.prefill', { v: fmtTps(metrics.prefillTps) }));
  if (metrics.decodeTps != null) parts.push(tr('msg.metrics.decode', { v: fmtTps(metrics.decodeTps) }));
  if (metrics.completionTokens != null) {
    const r = metrics.reasoningTokens;
    parts.push(tr('msg.metrics.tokens', { n: metrics.completionTokens }) + (r ? ' ' + tr('msg.metrics.reasoning', { n: r }) : ''));
  }
  if (!parts.length) return null;
  const est = metrics.source === 'estimated';
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityLabel={tr('msg.metrics.label')} style={styles.row}>
      <Text style={{ color: t.sub, fontSize: 11, flexShrink: 1 }}>{parts.join(' · ')}</Text>
      {est && (
        <View style={[styles.badge, { borderColor: t.border, borderRadius: th.r(6) }]}>
          <Text style={{ color: t.sub, fontSize: 10 }}>{tr('msg.metrics.est')}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', maxWidth: '88%', paddingHorizontal: 4, marginTop: 1 },
  badge: { borderWidth: 1, paddingHorizontal: 4, paddingVertical: 0 },
});
