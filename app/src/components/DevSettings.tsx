import React from 'react';
import { Text, View } from 'react-native';
import { useDevAvail } from '../devState';
import { useT } from '../i18n';
import { useTheme } from '../theme';
import { Btn, useDevMode } from '../ui/kit';
import CompareScreen from '../screens/CompareScreen';
import BenchScreen from '../screens/BenchScreen';

export type DevSub = 'compare' | 'bench';

/** Settings > Developer entries (developer mode only; hidden when the server does not know the endpoint). */
export function DevEntries({ onPick }: { onPick: (s: DevSub) => void }) {
  const t = useTheme();
  const tr = useT();
  const dev = useDevMode();
  const compare = useDevAvail('compare');
  const bench = useDevAvail('bench');
  if (!dev || (!compare && !bench)) return null;
  return (
    <View style={{ gap: 10, marginTop: 14 }}>
      <Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>{tr('settings.page.developer')}</Text>
      {compare && <Btn label={tr('dev.compare')} onPress={() => onPick('compare')} />}
      {bench && <Btn label={tr('dev.bench')} onPress={() => onPick('bench')} />}
    </View>
  );
}

export function DevSubScreen({ sub, onBack }: { sub: DevSub; onBack: () => void }) {
  return sub === 'compare' ? <CompareScreen onBack={onBack} /> : <BenchScreen onBack={onBack} />;
}
