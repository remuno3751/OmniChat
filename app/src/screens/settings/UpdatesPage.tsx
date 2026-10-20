import React from 'react';
import { useT } from '../../i18n';
import UpdatesSection from '../../components/UpdatesSection';
import { PageFrame } from './common';

/** Settings > Updates: versions, check button, release notes and the automatic-check options. */
export default function UpdatesPage({ onBack }: { onBack: () => void }) {
  const tr = useT();
  return (
    <PageFrame title={tr('settings.page.updates')} onBack={onBack}>
      <UpdatesSection />
    </PageFrame>
  );
}
