import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Icon from './Icon';
import { useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';
import { Btn } from '../ui/kit';
import { useFaces } from '../ui/skin';

/** Header badge marking an ephemeral chat ("Ephemeral - not saved"; `compact` on narrow widths). Uses the warn token in every theme. */
export function EphemeralBadge({ compact = false }: { compact?: boolean }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const faces = useFaces();
  return (
    <View
      accessibilityLabel={tr('eph.badge')}
      style={[styles.badge, { borderColor: t.warn, borderWidth: th.bw, borderRadius: th.r(8), backgroundColor: t.panel2 }]}
    >
      <Icon name="ephemeral" size={13} color={t.warn} />
      <Text numberOfLines={1} style={[styles.badgeText, { color: t.warn }, faces.labelBold]}>
        {tr(compact ? 'eph.badgeShort' : 'eph.badge')}
      </Text>
    </View>
  );
}

/** First-use explanation shown at the top of an ephemeral chat until it is dismissed (the flag lives in device settings). */
export default function EphemeralBanner({ minutes, onDismiss }: { minutes: number; onDismiss: () => void }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const faces = useFaces();
  return (
    <View accessibilityRole="alert" style={[styles.banner, { borderColor: t.warn, borderWidth: th.bw, borderRadius: th.r(10), backgroundColor: t.panel2 }]}>
      <Icon name="ephemeral" size={18} color={t.warn} />
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={[styles.title, { color: t.text }, faces.labelBold]}>{tr('eph.bannerTitle')}</Text>
        <Text style={{ color: t.sub, fontSize: 13, lineHeight: 18 }}>{tr('eph.bannerBody', { minutes })}</Text>
        <View style={{ alignSelf: 'flex-start', marginTop: 4 }}>
          <Btn small primary label={tr('eph.bannerOk')} onPress={onDismiss} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 2, maxWidth: 220 },
  badgeText: { fontSize: 11, fontWeight: '700' },
  banner: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 12, marginHorizontal: 14, marginTop: 10 },
  title: { fontSize: 14, fontWeight: '700' },
});
