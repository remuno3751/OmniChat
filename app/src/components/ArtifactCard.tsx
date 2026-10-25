import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { type Artifact, type ArtifactType, isEmptyArtifact, useArtifactOpener } from '../artifacts';
import { getDevice } from '../deviceSettings';
import { resolveLanguage, useT } from '../i18n';
import { useThemeDef, type Theme } from '../theme';
import Icon, { type IconName } from './Icon';

/*
 * Compact card shown in place of a fenced ```artifact block.
 * Three states:
 *  - generating (the fence is still open while streaming): no body is shown; a spinner and a progress line instead.
 *  - done: tapping the card (or its "Open in panel" button) hands the artifact to the chat's artifact panel.
 *  - empty (no body text): warning style, not openable.
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

export default function ArtifactCard({ artifact, t, generating }: {
  artifact: Artifact;
  t: Theme;
  /** set while the artifact is still streaming; `slides` counts the slides so far (pptx only) */
  generating?: { slides: number } | null;
}) {
  const opener = useArtifactOpener();
  const th = useThemeDef();
  const tr = useT();
  const meta = TYPE_META[artifact.type];
  const language = resolveLanguage(getDevice().language);

  if (generating) {
    const progress = artifact.type === 'pptx'
      ? tr('art.gen.slides', { n: generating.slides })
      : tr('art.gen.type', { type: meta.label });
    return (
      <View
        accessibilityLabel={`${progress}: ${artifact.title}`}
        style={[s.card, { backgroundColor: t.panel, borderColor: t.border, borderRadius: th.r(12) }]}
      >
        <View style={[s.iconWrap, { backgroundColor: t.bg, borderColor: t.border, borderRadius: th.r(8) }]}>
          <Icon name={meta.icon} size={22} color={t.accentInk} />
        </View>
        <View style={s.body}>
          <Text numberOfLines={1} style={[s.title, { color: t.text }]}>{artifact.title}</Text>
          <Text numberOfLines={1} style={[s.sub, { color: t.sub }]}>{progress}</Text>
        </View>
        <ActivityIndicator size="small" color={t.accentInk} />
      </View>
    );
  }

  const empty = isEmptyArtifact(artifact.content);
  const canOpen = !!opener && !empty;
  const tone = empty ? t.warn : t.border;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={tr(canOpen ? 'art.card.a11yOpen' : 'art.card.a11y', { type: meta.label, title: artifact.title })}
      accessibilityHint={empty ? tr('art.card.empty') : undefined}
      accessibilityState={{ disabled: !canOpen }}
      disabled={!canOpen}
      onPress={() => opener?.open(artifact)}
      style={({ pressed }) => [
        s.card,
        { backgroundColor: t.panel, borderColor: tone, opacity: pressed ? 0.85 : 1, borderRadius: th.r(12) },
      ]}
    >
      <View style={[s.iconWrap, { backgroundColor: t.bg, borderColor: tone, borderRadius: th.r(8) }]}>
        <Icon name={empty ? 'warning' : meta.icon} size={22} color={empty ? t.warn : t.accentInk} />
      </View>
      <View style={s.body}>
        <Text numberOfLines={1} style={[s.title, { color: t.text }]}>{artifact.title}</Text>
        {empty ? (
          <Text numberOfLines={2} style={[s.sub, { color: t.warn }]}>{tr('art.card.empty')}</Text>
        ) : (
          <>
            <Text numberOfLines={1} style={[s.sub, { color: t.sub }]}>
              {tr('art.card.meta', { type: meta.label, n: artifact.content.length.toLocaleString(language) })}
            </Text>
            <View style={s.doneRow}>
              <Icon name="check" size={12} color={t.good} />
              <Text numberOfLines={1} style={[s.sub, { color: t.good, marginTop: 0 }]}>{tr('art.card.created')}</Text>
            </View>
          </>
        )}
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
  doneRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  openBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 5, borderWidth: 1,
  },
  openText: { fontSize: 12, fontWeight: '600' },
});
