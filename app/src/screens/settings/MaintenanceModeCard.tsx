import React, { useEffect, useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { ApiError, api } from '../../api';
import { useT } from '../../i18n';
import { ETA_PRESETS, MAINTENANCE_MESSAGE_MAX, etaFromChoice, formatEtaLocal, validateMaintenanceMessage, type EtaChoice } from '../../maintenance';
import type { Maintenance } from '../../protocol';
import { setMaintenance } from '../../store';
import { useTheme } from '../../theme';
import { confirmDialog } from '../../ui/confirm';
import { Btn, Field, Hint, Label, Segmented } from '../../ui/kit';
import { toast } from '../../ui/toast';

const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Settings > Server: the maintenance mode switch, message and expected end. Admin only (parent renders the card frame). */
export default function MaintenanceModeCard() {
  const t = useTheme();
  const tr = useT();
  const [loaded, setLoaded] = useState<Maintenance | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState('');
  const [eta, setEta] = useState<EtaChoice>('keep');
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // copies the server's state into the form (after load and after each save)
  const apply = (m: Maintenance) => {
    setLoaded(m);
    setEnabled(m.enabled);
    setMessage(m.message);
    setEta(m.eta !== null ? 'keep' : 'none');
  };

  useEffect(() => {
    let alive = true;
    api.getMaintenance()
      .then((r) => { if (alive) apply(r.maintenance); })
      .catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 404) setUnsupported(true);
        else setLoadErr(msgOf(e));
      });
    return () => { alive = false; };
  }, []);

  // turning it on asks first; turning it off needs no confirmation
  const onToggle = async (v: boolean) => {
    if (v && !(await confirmDialog(tr('maint.title'), tr('maint.confirmBody'), tr('maint.confirmOk'), false))) return;
    setEnabled(v);
  };

  const msgErr = validateMaintenanceMessage(message);
  const storedEta = loaded ? (loaded.eta !== null ? 'keep' : 'none') : 'keep';
  const dirty = !!loaded && (enabled !== loaded.enabled || message.trim() !== loaded.message || eta !== storedEta);
  const canSave = dirty && !msgErr && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const patch: { enabled: boolean; message: string; eta?: number | null } = { enabled, message: message.trim() };
      const e = etaFromChoice(eta, Date.now());
      if (e !== undefined) patch.eta = e;
      const r = await api.putMaintenance(patch);
      apply(r.maintenance);
      setMaintenance(r.maintenance);
      toast(tr('admin.server.saved'), 'ok');
    } catch (e) {
      setSaveErr(msgOf(e));
    } finally {
      setSaving(false);
    }
  };

  if (unsupported) return <Hint>{tr('maint.unsupported')}</Hint>;
  if (loadErr) return <Hint danger>{`${tr('maint.loadFailed')} ${loadErr}`}</Hint>;
  if (!loaded) return <Hint>{tr('maint.loading')}</Hint>;

  const etaOptions: { value: EtaChoice; label: string }[] = [
    ...(loaded.eta !== null ? [{ value: 'keep' as EtaChoice, label: tr('maint.etaKeep') }] : []),
    { value: 'none', label: tr('maint.etaNone') },
    ...ETA_PRESETS.map((p) => ({ value: p, label: tr('maint.etaIn.' + p) })),
  ];
  const btnLabel = saving ? tr('admin.server.saving') : tr('admin.server.save');

  return (
    <View style={{ gap: 10 }}>
      <View style={styles.row}>
        <Text style={{ color: t.text, flex: 1, fontSize: 14 }}>{tr('maint.enabled')}</Text>
        <Switch
          value={enabled}
          onValueChange={onToggle}
          disabled={saving}
          trackColor={{ false: t.border, true: t.accent }}
          accessibilityLabel={tr('maint.enabled')}
        />
      </View>
      <Field label={tr('maint.message')} value={message} onChangeText={setMessage} multiline minHeight={80} />
      {msgErr
        ? <Hint danger>{tr(msgErr)}</Hint>
        : <Hint>{`${Array.from(message.trim()).length} / ${MAINTENANCE_MESSAGE_MAX}`}</Hint>}
      <Label>{tr('maint.etaLabel')}</Label>
      <Segmented options={etaOptions} value={eta} onChange={setEta} />
      {loaded.eta !== null && eta === 'keep' && <Hint>{tr('maint.eta', { time: formatEtaLocal(loaded.eta) })}</Hint>}
      {eta !== 'keep' && eta !== 'none' && <Hint>{tr('maint.etaHint')}</Hint>}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
        <Btn primary disabled={!canSave} onPress={save} label={btnLabel} />
        {saveErr ? <Text style={{ color: t.danger, fontSize: 13, flexShrink: 1 }}>{`${tr('admin.server.saveFailed')} ${saveErr}`}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});
