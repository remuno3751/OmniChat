import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { type Artifact, type ArtifactType, useArtifactOpener } from '../artifacts';
import { getDevice } from '../deviceSettings';
import { resolveLanguage, useT } from '../i18n';
import { useThemeDef, type Theme } from '../theme';
import Icon, { type IconName } from './Icon';

/*
 * Compact card shown in place of a fenced ```artifact block.
 * Tapping the card (or its "Open in panel" button) hands the artifact to the chat's artifact panel.
 * With no panel available (outside a chat), the card is shown but not tappable.
 */

const TYPE_META: Record<ArtifactType, { icon: IconName; label: string }> = {
  markdown: { icon: 'docMarkdown', label: 'Markdown' },
  html: { icon: 'docHtml', label: 'HTML' },
  docx: { icon: 'docWord', label: 'Word' },
  pptx: { icon: 'docSlides', label: 'PowerPoint' },
  xlsx: { icon: 'docSheet', label: 'Excel' },
  email: { icon: 'docMail', label: 'Email' },
};

export default function ArtifactCard({ artifact, t }: { artifact: Artifact; t: Theme }) {
  const opener = useArtifactOpener();
  const th = useThemeDef();
  const tr = useT();
  const meta = TYPE_META[artifact.type];
  const chars = artifact.content.length.toLocaleString(resolveLanguage(getDevice().language));
  const canOpen = !!opener;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={tr(canOpen ? 'art.card.a11yOpen' : 'art.card.a11y', { type: meta.label, title: artifact.title })}
      accessibilityState={{ disabled: !canOpen }}
      disabled={!canOpen}
      onPress={() => opener?.open(artifact)}
      style={({ pressed }) => [
        s.card,
        { backgroundColor: t.panel, borderColor: t.border, opacity: pressed ? 0.85 : 1, borderRadius: th.r(12) },
      ]}
    >
      <View style={[s.iconWrap, { backgroundColor: t.bg, borderColor: t.border, borderRadius: th.r(8) }]}>
        <Icon name={meta.icon} size={22} color={t.accentInk} />
      </View>
      <View style={s.body}>
        <Text numberOfLines={1} style={[s.title, { color: t.text }]}>{artifact.title}</Text>
        <Text numberOfLines={1} style={[s.sub, { color: t.sub }]}>{tr('art.card.meta', { type: meta.label, n: chars })}</Text>
      </View>
      {canOpen && (
        <View style={[s.openBtn, { borderColor: t.border, backgroundColor: t.bg, borderRadius: th.r(6) }]}>
          <Icon name="openPanel" size={16} color={t.text} />
          <Text style={[s.openText, { color: t.text }]}>{tr('art.openPanel')}</Text>
        </View>
      )}
    </Pressable>
  );
}

const s = StyleSheet.create({
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderWidth: 1, paddingVertical: 10, paddingHorizontal: 12,
    marginVertical: 6, maxWidth: 480,
  },
  iconWrap: {
    width: 40, height: 40, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, fontWeight: '700' },
  sub: { fontSize: 12, marginTop: 2 },
  openBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 5, borderWidth: 1,
  },
  openText: { fontSize: 12, fontWeight: '600' },
});
