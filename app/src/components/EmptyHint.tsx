import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';
import { Barcode, Contour, CornerTicks, Emblem, Enter, Speech, Tag } from '../ui/skin';

/**
 * Hint on an empty conversation. Simple: centred grey text. Frontier-style: an inverted "TIPS" tag
 * beside airy body text. Astral-style: a speech bubble with a tail.
 */
export default function EmptyHint({ text }: { text: string }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const v = th.def.variants.hint;
  if (v === 'tips') {
    // Frontier: inspection-label card: inverted TIPS tag, contour lines, accent edge, airy text
    return (
      <Enter style={[styles.tips, { borderLeftColor: th.dark ? t.accent : t.text, borderColor: t.border, backgroundColor: t.panel }]}>
        <Contour color={t.text} opacity={th.dark ? 0.1 : 0.09} />
        <View style={styles.tipsHead}>
          <Tag>{tr('hint.tips')}:</Tag>
          <View style={{ flex: 1, height: 1, backgroundColor: t.border }} />
          {th.fx && <Barcode width={36} height={8} color={t.sub} />}
        </View>
        <Text style={{ color: t.text, fontSize: 15, lineHeight: 25, marginTop: 10 }}>{text}</Text>
        <CornerTicks color={t.borderStrong} />
      </Enter>
    );
  }
  if (v === 'speech') {
    // Astral: an original round emblem "speaks" through a white bubble
    return (
      <Enter style={styles.speechWrap}>
        <Speech style={{ flexShrink: 1, maxWidth: 400 }}>
          <Text style={{ color: '#2a2827', fontSize: 15, lineHeight: 24 }}>{text}</Text>
        </Speech>
        <View style={{ marginLeft: 6 }}><Emblem size={36} /></View>
      </Enter>
    );
  }
  return <Text style={[styles.plain, { color: t.sub }]}>{text}</Text>;
}

const styles = StyleSheet.create({
  plain: { textAlign: 'center', marginTop: 40 },
  tips: { alignSelf: 'center', marginTop: 48, maxWidth: 500, width: '100%', paddingHorizontal: 18, paddingVertical: 16, borderWidth: 1, borderLeftWidth: 3, overflow: 'hidden' },
  tipsHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  speechWrap: { alignSelf: 'center', marginTop: 48, maxWidth: 460, width: '100%', paddingHorizontal: 8 },
});
