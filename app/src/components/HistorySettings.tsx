import React from 'react';
import { View } from 'react-native';
import { requestSearch, useHistoryAvailable, useIsAdminProbe, useProbes } from '../historyNav';
import { useT } from '../i18n';
import { NavRow, Section } from '../screens/settings/common';
import BackupScreen from '../screens/BackupScreen';
import DataScreen from '../screens/DataScreen';

export type HistSub = 'backup' | 'data';

/** Settings entries added by phase 3 (search, data export/import, backup for admins). Hidden on old servers. */
export function HistoryEntries({ onPick }: { onPick: (s: HistSub) => void }) {
  const tr = useT();
  useProbes(true, true);
  const hist = useHistoryAvailable();
  const admin = useIsAdminProbe();
  if (!hist) return null;
  return (
    <>
      <Section title={tr('hist.title')} />
      <View style={{ gap: 8 }}>
        <NavRow title={tr('list.searchHistory')} onPress={requestSearch} />
        <NavRow title={tr('hist.data')} onPress={() => onPick('data')} />
        {admin && <NavRow title={tr('hist.backup')} onPress={() => onPick('backup')} />}
      </View>
    </>
  );
}

export function HistorySubScreen({ sub, onBack }: { sub: HistSub; onBack: () => void }) {
  return sub === 'backup' ? <BackupScreen onBack={onBack} /> : <DataScreen onBack={onBack} />;
}
