import React, { useMemo } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useThemeDef, type Theme } from '../theme';
import { useT } from '../i18n';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });
const MAX_LINES = 2000;

/** Colour of one unified-diff line: '+' green tint, '-' red tint, '@@' accent, the rest plain. */
function lineColors(ln: string, t: Theme): { color: string; bg?: string; mark?: string } {
  if (ln.startsWith('@@')) return { color: t.accentInk };
  if (ln.startsWith('+') && !ln.startsWith('+++')) return { color: t.text, bg: t.diffAdd + '22', mark: t.diffAdd };
  if (ln.startsWith('-') && !ln.startsWith('---')) return { color: t.text, bg: t.diffDel + '22', mark: t.diffDel };
  return { color: t.text };
}

/** Unified diff viewer: monospace, horizontally scrollable, selectable, first 2000 lines only. */
export default function DiffView({ patch, t }: { patch: string; t: Theme }) {
  const tr = useT();
  const themed = useThemeDef().def.id !== 'simple';
  const { lines, total } = useMemo(() => {
    const all = patch.split('\n').map((l) => l.replace(/\r$/, ''));
    return { lines: all.length > MAX_LINES ? all.slice(0, MAX_LINES) : all, total: all.length };
  }, [patch]);

  return (
    <View>
      <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
        <View style={{ paddingVertical: 4 }}>
          {lines.map((ln, i) => {
            const c = lineColors(ln, t);
            return (
              <Text key={i} selectable style={[styles.line, { color: c.color, backgroundColor: c.bg ?? 'transparent' }, themed && c.mark ? { borderLeftWidth: 3, borderLeftColor: c.mark, paddingLeft: 5 } : null]}>
                {ln.length ? ln : ' '}
              </Text>
            );
          })}
        </View>
      </ScrollView>
      {total > MAX_LINES && (
        <Text style={{ color: t.sub, fontSize: 11, marginTop: 6 }}>{tr('code.truncated', { n: MAX_LINES })}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  line: { fontFamily: MONO, fontSize: 12, lineHeight: 17, paddingHorizontal: 8 },
});
