import React from 'react';
import { Text, View } from 'react-native';
import { requestSearch, useHistoryAvailable, useIsAdminProbe, useProbes } from '../historyNav';
import { useT } from '../i18n';
import { useTheme } from '../theme';
import { Btn } from '../ui/kit';
import BackupScreen from '../screens/BackupScreen';
import DataScreen from '../screens/DataScreen';

export type HistSub = 'backup' | 'data';

/** Settings entries added by phase 3 (search, data export/import, backup for admins). Hidden on old servers. */
export function HistoryEntries({ onPick }: { onPick: (s: HistSub) => void }) {
  const t = useTheme();
  const tr = useT();
  useProbes(true, true);
  const hist = useHistoryAvailable();
  const admin = useIsAdminProbe();
  if (!hist) return null;
  return (
    <View style={{ gap: 10, marginTop: 14 }}>
      <Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>{tr('hist.title')}</Text>
      <Btn label={tr('list.searchHistory')} onPress={requestSearch} />
      <Btn label={tr('hist.data')} onPress={() => onPick('data')} />
      {admin && <Btn label={tr('hist.backup')} onPress={() => onPick('backup')} />}
    </View>
  );
}

export function HistorySubScreen({ sub, onBack }: { sub: HistSub; onBack: () => void }) {
  return sub === 'backup' ? <BackupScreen onBack={onBack} /> : <DataScreen onBack={onBack} />;
}
