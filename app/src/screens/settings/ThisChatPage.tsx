import React from 'react';
import { ChatSettingsBody } from '../../components/ChatSettingsSheet';
import { useT } from '../../i18n';
import { Hint } from '../../ui/kit';
import { PageFrame } from './common';

/** Settings > This chat: per-conversation settings of the open chat. */
export default function ThisChatPage({ convId, onBack }: { convId: string | null; onBack: () => void }) {
  const t = useT();
  return (
    <PageFrame title={t('settings.thisChat')} onBack={onBack}>
      {convId ? <ChatSettingsBody convId={convId} /> : <Hint>{t('settings.thisChat.disabled')}</Hint>}
    </PageFrame>
  );
}
