import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useT } from '../i18n';
import { useTheme } from '../theme';
import { heatWeeks } from '../usageFormat';

/** 0..4 colors: gray, then yellow up to black (the same ramp as the server app's statistics page). Dark backgrounds use a bright ramp. */
const RAMP_LIGHT = ['#e6e6e6', '#fff6a6', '#ffe600', '#c9a400', '#191919'];
const RAMP_DARK = ['#26272b', '#47441a', '#8f8a12', '#dcd400', '#fffa00'];

/** Hex color -> true when it is dark (relative luminance < 0.4). Anything that is not #rrggbb counts as light. */
export function isDarkColor(hex: string): boolean {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum < 0.4;
}

/** Calendar heat map of tokens per day: one column per week, Sunday first. */
export default function UsageHeatmap({ days }: { days: { day: string; totalTokens: number }[] }) {
  const t = useTheme();
  const tr = useT();
  const ramp = isDarkColor(t.bg) ? RAMP_DARK : RAMP_LIGHT;
  const weeks = heatWeeks(days);
  return (
    <View accessible accessibilityLabel={tr('usage.heat')}>
      <View style={styles.grid}>
        {weeks.map((w, wi) => (
          <View key={wi} style={styles.col}>
            {w.map((c, di) => (
              <View
                key={di}
                // @ts-ignore title is the web tooltip (ignored on native)
                title={c ? `${c.day}: ${c.total}` : undefined}
                style={[styles.cell, { backgroundColor: c ? ramp[c.level] : 'transparent' }]}
              />
            ))}
          </View>
        ))}
      </View>
      <View style={styles.legend}>
        <Text style={{ color: t.sub, fontSize: 11 }}>{tr('usage.heat.less')}</Text>
        {ramp.map((c, i) => <View key={i} style={[styles.sw, { backgroundColor: c }]} />)}
        <Text style={{ color: t.sub, fontSize: 11 }}>{tr('usage.heat.more')}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', gap: 3 },
  col: { flex: 1, gap: 3 },
  cell: { width: '100%', maxWidth: 24, aspectRatio: 1 },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 8 },
  sw: { width: 12, height: 12 },
});
