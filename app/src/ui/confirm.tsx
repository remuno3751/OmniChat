import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Btn, Sheet } from './kit';
import { useTheme } from '../theme';
import { t, useT } from '../i18n';

interface Req { title: string; message?: string; ok: string; danger: boolean; resolve: (v: boolean) => void }
let cur: Req | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

/** Promise-based confirm dialog (Alert.alert does not work on web). Needs <ConfirmHost/> mounted once. */
export function confirmDialog(title: string, message?: string, ok = t('common.confirm'), danger = true): Promise<boolean> {
  return new Promise((resolve) => {
    cur?.resolve(false);
    cur = { title, message, ok, danger, resolve };
    emit();
  });
}

export function ConfirmHost() {
  const t = useTheme();
  const tr = useT();
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    subs.add(f);
    return () => { subs.delete(f); };
  }, []);
  const r = cur;
  const done = (v: boolean) => { const c = cur; cur = null; emit(); c?.resolve(v); };
  return (
    <Sheet visible={!!r} onClose={() => done(false)} title={r?.title} width={420}>
      {!!r?.message && <Text style={{ color: t.text, fontSize: 15, lineHeight: 21 }}>{r.message}</Text>}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 16 }}>
        <Btn label={r?.ok || tr('common.ok')} danger={r?.danger} primary={!r?.danger} onPress={() => done(true)} />
        <Btn label={tr('common.cancel')} onPress={() => done(false)} />
      </View>
    </Sheet>
  );
}
