import React from 'react';
import { Text, View } from 'react-native';
import type { Metrics } from '../protocol';
import { useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';
import Icon from './Icon';

/** `JSON ✓` / `JSON ✗ <error>` (renders nothing unless metrics.jsonValid is set). */
export default function JsonBadge({ metrics }: { metrics: Metrics | null | undefined }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  if (metrics?.jsonValid === undefined || metrics.jsonValid === null) return null;
  const ok = !!metrics.jsonValid;
  const color = ok ? t.good : t.danger;
  return (
    <View
      accessibilityLabel={ok ? tr('msg.json.valid') : tr('msg.json.invalid', { error: metrics.jsonError || '' })}
      style={[{ alignSelf: 'flex-start', flexDirection: 'row', borderWidth: 1, borderColor: color, paddingHorizontal: 5, paddingVertical: 1, marginTop: 2, maxWidth: '100%' }, { borderRadius: th.r(6) }]}
    >
      <Icon name={ok ? 'check' : 'error'} size={13} color={color} />
      <Text numberOfLines={2} style={{ color, fontSize: 11, fontWeight: '700', marginLeft: 3, flexShrink: 1 }}>{ok ? 'JSON' : `JSON${metrics.jsonError ? ' ' + metrics.jsonError : ''}`}</Text>
    </View>
  );
}
