import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { emailPlaceholders, parseEmail } from '../../email';
import { useT } from '../../i18n';
import { useThemeDef, useTheme } from '../../theme';
import type { Theme } from '../../theme';
import Icon from '../Icon';
import Markdown from '../Markdown';

/*
 * Preview of an email artifact: a mail card (To / Cc / Bcc / Subject), then the body rendered as Markdown.
 * Placeholders left in the body ([要確認: ...], [TODO: ...] and similar) are listed in a warning strip above.
 * The actions (copy, open in the mail app) belong to the panel, not to this preview.
 */

function HeaderRow({ label, value, t, dim }: { label: string; value: string; t: Theme; dim?: string }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: t.sub }]}>{label}</Text>
      <Text style={[styles.rowValue, { color: t.text }, dim ? { color: t.sub, fontStyle: 'italic' } : null]}>{dim ?? value}</Text>
    </View>
  );
}

export default function EmailPreview({ content }: { content: string }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const mail = useMemo(() => parseEmail(content), [content]);
  const placeholders = useMemo(() => emailPlaceholders(mail.body), [mail.body]);
  return (
    <ScrollView style={[styles.root, { backgroundColor: t.bg }]} contentContainerStyle={styles.content}>
      {placeholders.length ? (
        <View style={[styles.warn, { borderColor: t.warn, borderRadius: th.r(8) }]}>
          <View style={styles.warnHead}>
            <Icon name="warning" size={16} color={t.warn} />
            <Text style={[styles.warnTitle, { color: t.text }]}>{tr('art.mail.placeholders', { n: placeholders.length })}</Text>
          </View>
          {placeholders.map((p, i) => (
            <Text key={i} style={[styles.warnItem, { color: t.sub }]}>{p}</Text>
          ))}
        </View>
      ) : null}
      <View style={[styles.card, { backgroundColor: t.panel, borderColor: t.border, borderRadius: th.r(8) }]}>
        <HeaderRow label={tr('art.mail.to')} value={mail.to} t={t} dim={mail.to ? undefined : tr('art.mail.noRecipient')} />
        {mail.cc ? <HeaderRow label={tr('art.mail.cc')} value={mail.cc} t={t} /> : null}
        {mail.bcc ? <HeaderRow label={tr('art.mail.bcc')} value={mail.bcc} t={t} /> : null}
        <Text style={[styles.subject, { color: t.text }, mail.subject ? null : { color: t.sub, fontStyle: 'italic', fontWeight: '400' }]}>
          {mail.subject || tr('art.mail.noSubject')}
        </Text>
        <View style={[styles.divider, { backgroundColor: t.border }]} />
        <Markdown text={mail.body} t={t} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 12, gap: 10 },
  card: { borderWidth: 1, padding: 14 },
  row: { flexDirection: 'row', gap: 10, marginBottom: 4 },
  rowLabel: { width: 44, fontSize: 12, paddingTop: 2 },
  rowValue: { flex: 1, fontSize: 14, lineHeight: 20 },
  subject: { fontSize: 18, fontWeight: '700', marginTop: 8, marginBottom: 2 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 12 },
  warn: { borderWidth: 1, padding: 10, gap: 4 },
  warnHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  warnTitle: { fontSize: 13, fontWeight: '700' },
  warnItem: { fontSize: 12, paddingLeft: 22 },
});
