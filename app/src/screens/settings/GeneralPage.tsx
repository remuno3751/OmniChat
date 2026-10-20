import React, { useState } from 'react';
import { Text } from 'react-native';
import { ApiError, api, getServerUrl } from '../../api';
import { useDeviceSetting } from '../../deviceSettings';
import type { Language } from '../../deviceSettings';
import { useT } from '../../i18n';
import { useStore } from '../../store';
import { useTheme } from '../../theme';
import { Btn, Field, Hint, Label, Segmented } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { PageFrame, Section } from './common';

/** Settings > General: device language and the account (log out). */
export default function GeneralPage({ onBack, onLogout }: { onBack: () => void; onLogout: () => void }) {
  const t = useTheme();
  const tr = useT();
  const [language, setLanguage] = useDeviceSetting('language');
  const user = useStore((s) => s.user);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [pwErr, setPwErr] = useState('');
  const [busy, setBusy] = useState(false);
  const changePassword = async () => {
    setPwErr('');
    if (next.length < 8) { setPwErr(tr('settings.password.short')); return; }
    if (next !== again) { setPwErr(tr('settings.password.mismatch')); return; }
    setBusy(true);
    try {
      const r = await api.changePassword(cur, next);
      setCur(''); setNext(''); setAgain('');
      toast(tr('settings.password.done', { n: r.revokedDevices }), 'ok');
    } catch (e: any) {
      setPwErr(e instanceof ApiError && e.status === 403 ? tr('settings.password.wrong') : (e?.message || String(e)));
    } finally { setBusy(false); }
  };
  return (
    <PageFrame title={tr('settings.page.general')} onBack={onBack}>
      <Label>{tr('appearance.language')}</Label>
      <Segmented<Language>
        value={language}
        onChange={setLanguage}
        options={[
          { value: 'auto', label: tr('language.auto') },
          { value: 'ja', label: tr('language.ja') },
          { value: 'en', label: tr('language.en') },
        ]}
      />
      <Section title={tr('settings.account')} />
      <Text style={{ color: t.sub }}>{user?.username} @ {getServerUrl()}</Text>
      <Section title={tr('settings.password.title')} />
      <Field label={tr('settings.password.current')} value={cur} onChangeText={setCur} secure />
      <Field label={tr('settings.password.new')} value={next} onChangeText={setNext} secure />
      <Field label={tr('settings.password.confirm')} value={again} onChangeText={setAgain} secure onSubmit={changePassword} />
      {!!pwErr && <Text style={{ color: t.danger }} accessibilityRole="alert">{pwErr}</Text>}
      <Hint>{tr('settings.password.hint')}</Hint>
      <Btn label={tr('settings.password.change')} onPress={changePassword} disabled={busy || !cur || !next || !again} />
      <Section title={tr('settings.logout')} />
      <Btn danger label={tr('settings.logout')} onPress={onLogout} />
    </PageFrame>
  );
}
