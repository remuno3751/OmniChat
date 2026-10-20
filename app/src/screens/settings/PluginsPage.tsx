import React, { useState } from 'react';
import { BACK_PRIORITY } from '../../backHandler';
import { useBack } from '../../ui/useBack';
import { DshIntegration } from '../../components/DshIntegration';
import { P3SubScreen } from '../../components/ToolsSettings';
import { SearchIntegration } from '../../components/SearchIntegration';
import { useT } from '../../i18n';
import type { SettingsPageId } from '../../settingsMeta';
import { useTools } from '../../toolState';
import { Btn, Hint } from '../../ui/kit';
import { PageFrame, Section } from './common';

/**
 * Settings > Plugins: integration cards (DeepSeek Harness, web search), then the Tools screen.
 * `onGoto` opens another settings page (passed from SettingsScreen).
 */
export default function PluginsPage({ onBack, onGoto }: { onBack: () => void; onGoto?: (page: SettingsPageId) => void }) {
  const tr = useT();
  const hasTools = !!useTools().value;
  const [open, setOpen] = useState(false);
  useBack(open, BACK_PRIORITY.SUBPAGE + 1, () => { setOpen(false); });

  if (open) return <P3SubScreen sub="tools" onBack={() => setOpen(false)} />;


  return (
    <PageFrame title={tr('settings.page.plugins')} onBack={onBack}>
      <Section title={tr('integ.title')} first />
      <Hint>{tr('integ.hint')}</Hint>
      {/* one compact row per plugin; tapping a row opens its details */}
      <DshIntegration />
      <SearchIntegration onGoto={onGoto} />
      {hasTools ? (
        <>
          <Hint>{tr('set.plugins.hint')}</Hint>
          <Btn label={tr('code.tools')} onPress={() => setOpen(true)} />
        </>
      ) : (
        <Hint>{tr('settings.unavailable')}</Hint>
      )}
    </PageFrame>
  );
}
