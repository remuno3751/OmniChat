// Settings > Usage: the signed-in user's token use on shared providers, against the day and month limits (PROTOCOL-v7-quotas).
// Shown only when the quota applies to this user (an ordinary user with a shared provider); otherwise renders nothing.
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { getQuotaStatus } from '../../apiAdmin';
import { useT } from '../../i18n';
import { formatResetAt, formatTokens, isExhausted, showUsageCard, usageRatio, type QuotaStatus, type QuotaWindow } from '../../quota';
import { useTheme } from '../../theme';
import { Hint } from '../../ui/kit';
import { Section } from './common';

function UsageWindow({ label, w }: { label: string; w: QuotaWindow }) {
  const t = useTheme();
  const tr = useT();
  const ratio = usageRatio(w.used, w.limit);
  const over = isExhausted(w.used, w.limit);
  const amount = w.limit === null
    ? tr('quota.card.usedNoLimit', { used: formatTokens(w.used) })
    : tr('quota.card.used', { used: formatTokens(w.used), limit: formatTokens(w.limit) });
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <Text style={{ color: t.text, fontSize: 13, fontWeight: '600' }}>{label}</Text>
        <Text style={{ color: over ? t.danger : t.sub, fontSize: 12 }}>{amount}</Text>
      </View>
      {ratio !== null ? (
        <View style={{ height: 8, borderRadius: 4, backgroundColor: t.input, overflow: 'hidden' }}>
          <View style={{ height: 8, width: `${Math.round(ratio * 100)}%`, backgroundColor: over ? t.danger : t.accentInk }} />
        </View>
      ) : null}
      <Text style={{ color: t.sub, fontSize: 11 }}>{tr('quota.card.resets', { when: formatResetAt(w.resetsAt) })}</Text>
    </View>
  );
}

export default function QuotaUsageCard() {
  const tr = useT();
  const t = useTheme();
  const [st, setSt] = useState<QuotaStatus | 'err' | null>(null);
  useEffect(() => {
    let alive = true;
    getQuotaStatus().then((s) => { if (alive) setSt(s); }).catch(() => { if (alive) setSt('err'); });
    return () => { alive = false; };
  }, []);
  if (st === null) return <ActivityIndicator color={t.accentInk} style={{ margin: 12 }} />;
  if (st === 'err' || !showUsageCard(st)) return null;
  return (
    <View style={{ gap: 12 }}>
      <Section title={tr('quota.card.title')} />
      <Hint>{tr('quota.card.hint')}</Hint>
      {!st.enabled ? <Hint>{tr('quota.card.off')}</Hint> : null}
      <UsageWindow label={tr('quota.card.today')} w={st.daily} />
      <UsageWindow label={tr('quota.card.month')} w={st.monthly} />
    </View>
  );
}
