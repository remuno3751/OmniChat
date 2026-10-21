import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { getServerUrl } from '../../api';
import { HistoryEntries, HistorySubScreen } from '../../components/HistorySettings';
import type { HistSub } from '../../components/HistorySettings';
import { useT } from '../../i18n';
import { useStore } from '../../store';
import { useTheme } from '../../theme';
import { useV3 } from '../../ui/kit';
import ApiKeysScreen from '../ApiKeysScreen';
import DevicesScreen from '../DevicesScreen';
import StatsScreen from '../StatsScreen';
import UsageScreen from '../UsageScreen';
import QuotaUsageCard from './QuotaUsageCard';
import DesktopServerSwitch from '../../components/DesktopServerSwitch';
import { NavRow, PageFrame, Section } from './common';
import { BACK_PRIORITY } from '../../backHandler';
import { useBack } from '../../ui/useBack';

export type ConnSub = 'stats' | 'devices' | 'apikeys' | 'usage';

/** Settings > Connections: usage, devices and keys, history, and the account / server. */
export default function ConnectionsPage({ onBack, onLogout, initialSub, onOpenChat }: {
  onBack: () => void; onLogout: () => void; initialSub?: ConnSub;
  /** opens a chat from the Usage list (wired by App) */
  onOpenChat?: (id: string) => void;
}) {
  const t = useTheme();
  const tr = useT();
  const v3 = useV3();
  const user = useStore((s) => s.user);
  const [sub, setSub] = useState<ConnSub | null>(initialSub ?? null);
  const [hist, setHist] = useState<HistSub | null>(null);
  useBack(!!hist, BACK_PRIORITY.SUBPAGE + 1, () => { setHist(null); });
  useBack(sub !== null, BACK_PRIORITY.SUBPAGE + 1, () => { setSub(null); });

  if (hist) return <HistorySubScreen sub={hist} onBack={() => setHist(null)} />;
  if (sub === 'stats') return <StatsScreen onBack={() => setSub(null)} />;
  if (sub === 'devices') return <DevicesScreen onBack={() => setSub(null)} onLoggedOut={onLogout} />;
  if (sub === 'apikeys') return <ApiKeysScreen onBack={() => setSub(null)} />;
  if (sub === 'usage') return <UsageScreen onBack={() => setSub(null)} onOpenChat={onOpenChat} />;

  return (
    <PageFrame title={tr('settings.page.connections')} onBack={onBack}>
      {v3 && (
        <>
          <Section title={tr('conn.sec.usage')} first />
          <View style={{ gap: 8 }}>
            <NavRow title={tr('settings.statistics')} hint={tr('conn.hint.stats')} onPress={() => setSub('stats')} />
            <NavRow title={tr('settings.usage')} hint={tr('conn.hint.usage')} onPress={() => setSub('usage')} />
          </View>
          <QuotaUsageCard />
          <Section title={tr('conn.sec.access')} />
          <View style={{ gap: 8 }}>
            <NavRow title={tr('settings.devices')} hint={tr('conn.hint.devices')} onPress={() => setSub('devices')} />
            <NavRow title={tr('settings.apiKeys')} hint={tr('conn.hint.apikeys')} onPress={() => setSub('apikeys')} />
          </View>
        </>
      )}
      {!v3 && <QuotaUsageCard />}
      <HistoryEntries onPick={setHist} />
      <Section title={tr('settings.server')} />
      <Text style={{ color: t.sub }}>{user?.username} @ {getServerUrl()}</Text>
      <DesktopServerSwitch />
    </PageFrame>
  );
}
