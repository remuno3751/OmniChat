import React, { useState } from 'react';
import { BACK_PRIORITY } from '../../backHandler';
import { useBack } from '../../ui/useBack';
import { Text } from 'react-native';
import { DevEntries, DevSubScreen } from '../../components/DevSettings';
import type { DevSub } from '../../components/DevSettings';
import { useT } from '../../i18n';
import { useTheme } from '../../theme';
import { Hint, useDevMode } from '../../ui/kit';
import { PageFrame, Section } from './common';

/** Settings > Developer: developer-mode state, compare and benchmark tools (when available). */
export default function DeveloperPage({ onBack }: { onBack: () => void }) {
  const t = useTheme();
  const tr = useT();
  const dev = useDevMode();
  const [sub, setSub] = useState<DevSub | null>(null);
  useBack(sub !== null, BACK_PRIORITY.SUBPAGE + 1, () => { setSub(null); });

  if (sub) return <DevSubScreen sub={sub} onBack={() => setSub(null)} />;

  return (
    <PageFrame title={tr('settings.page.developer')} onBack={onBack}>
      <Section title={tr('label.devMode')} first />
      <Text style={{ color: t.text }}>{tr('label.devMode')}: {dev ? tr('common.on') : tr('common.off')}</Text>
      <Hint>{tr('settings.devInfo')}</Hint>
      <DevEntries onPick={setSub} />
    </PageFrame>
  );
}
