import React, { useState } from 'react';
import { BACK_PRIORITY } from '../../backHandler';
import { useBack } from '../../ui/useBack';
import { View } from 'react-native';
import DevModeSwitch from '../../components/DevModeSwitch';
import { DevEntries, DevSubScreen } from '../../components/DevSettings';
import type { DevSub } from '../../components/DevSettings';
import { useT } from '../../i18n';
import { Btn, Hint, useDevMode, useV3 } from '../../ui/kit';
import ApiKeysScreen from '../ApiKeysScreen';
import { PageFrame, Section } from './common';

/** Settings > Developer: the developer-mode switch, API keys, compare and benchmark tools (when available). */
export default function DeveloperPage({ onBack }: { onBack: () => void }) {
  const tr = useT();
  const dev = useDevMode();
  const v3 = useV3();
  const [sub, setSub] = useState<DevSub | null>(null);
  const [apiKeys, setApiKeys] = useState(false);
  useBack(sub !== null, BACK_PRIORITY.SUBPAGE + 1, () => { setSub(null); });
  useBack(apiKeys, BACK_PRIORITY.SUBPAGE + 1, () => { setApiKeys(false); });

  if (sub) return <DevSubScreen sub={sub} onBack={() => setSub(null)} />;
  if (apiKeys) return <ApiKeysScreen onBack={() => setApiKeys(false)} />;

  return (
    <PageFrame title={tr('settings.page.developer')} onBack={onBack}>
      <Section title={tr('label.devMode')} first />
      {v3 ? <DevModeSwitch /> : <Hint>{tr('settings.unavailable')}</Hint>}
      {v3 && dev && <View style={{ marginTop: 6 }}><Btn label={tr('set.apiKeysBtn')} onPress={() => setApiKeys(true)} /></View>}
      <DevEntries onPick={setSub} />
    </PageFrame>
  );
}
