import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { adminApi, type AdminGeneral } from '../../apiAdmin';
import { useT } from '../../i18n';
import { useTheme } from '../../theme';
import { Btn, Check, Hint, Label, Segmented } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { parseDefaultSharedAccess, type DefaultSharedAccess } from '../../sharedProviders';

const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Settings > Server > Shared providers: the default access of users with no grant row, and whether ordinary
 * users may add their own providers. Saved with PUT /admin/settings. Hidden on an old server (no such fields).
 */
export default function SharedProvidersCard() {
  const t = useTheme();
  const tr = useT();
  const [gen, setGen] = useState<AdminGeneral | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [def, setDef] = useState<DefaultSharedAccess>('none');
  const [own, setOwn] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  useEffect(() => {
    adminApi.settings().then((r) => {
      setGen(r.general);
      setDef(parseDefaultSharedAccess(r.general.defaultSharedAccess));
      setOwn(r.general.allowOwnProviders !== false);
    }).catch((e) => setLoadErr(msgOf(e)));
  }, []);

  if (loadErr) return <Hint danger>{loadErr}</Hint>;
  if (!gen) return <ActivityIndicator color={t.accentInk} style={{ margin: 12 }} />;
  // an old server has no shared providers and sends neither field
  if (gen.defaultSharedAccess === undefined && gen.allowOwnProviders === undefined) return <Hint>{tr('shared.card.unsupported')}</Hint>;

  const dirty = def !== parseDefaultSharedAccess(gen.defaultSharedAccess) || own !== (gen.allowOwnProviders !== false);
  const save = async () => {
    setSaving(true);
    setSaveErr(null);
    try {
      const r = await adminApi.putSettings({ defaultSharedAccess: def, allowOwnProviders: own });
      setGen(r.general);
      toast(tr('shared.card.saved'), 'ok');
    } catch (e) {
      setSaveErr(msgOf(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={{ gap: 10 }}>
      <Hint>{tr('shared.card.hint')}</Hint>
      <Label>{tr('shared.card.defaultAccess')}</Label>
      <Segmented<DefaultSharedAccess>
        options={[
          { value: 'none', label: tr('shared.card.none') },
          { value: 'all', label: tr('shared.card.all') },
        ]}
        value={def}
        onChange={setDef}
      />
      <Hint>{tr('shared.card.defaultHint')}</Hint>
      <Check label={tr('shared.card.allowOwn')} value={own} onChange={setOwn} hint={tr('shared.card.allowOwnHint')} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
        <Btn primary disabled={!dirty || saving} onPress={save} label={saving ? tr('admin.server.saving') : tr('admin.server.save')} />
        {saveErr ? <Text style={{ color: t.danger, fontSize: 13, flexShrink: 1 }}>{`${tr('admin.server.saveFailed')} ${saveErr}`}</Text> : null}
      </View>
    </View>
  );
}
