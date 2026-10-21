import React from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { applyUpsert, patchSettingsLocal } from '../store';
import { Check, useDevMode } from '../ui/kit';
import { toast } from '../ui/toast';

/** The developer-mode switch (synced across devices through the server settings). Shown on Settings > Developer. */
export default function DevModeSwitch() {
  const tr = useT();
  const dev = useDevMode();
  const toggle = async (v: boolean) => {
    patchSettingsLocal({ devMode: v });
    try { applyUpsert({ settings: await api.putSettings({ devMode: v }) }); } catch (e: any) {
      patchSettingsLocal({ devMode: !v });
      toast(e.message || tr('set.devModeFailed'), 'error');
    }
  };
  return <Check label={tr('label.devMode')} value={dev} onChange={toggle} hint={tr('set.devModeHint')} />;
}
