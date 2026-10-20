import React, { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { api, uuid } from '../api';
import type { SystemMode } from '../protocol';
import { activePresets, applyUpsert, useStore } from '../store';
import { useTheme } from '../theme';
import { useT } from '../i18n';
import { confirmDialog } from '../ui/confirm';
import { Btn, Field, Hint, Label, Segmented, Sheet, useV3 } from '../ui/kit';
import { toast } from '../ui/toast';

interface Props {
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** omit for the global level (always the base) */
  mode?: SystemMode;
  onMode?: (m: SystemMode) => void;
  hint?: string;
}

export default function PromptEditor({ label, value, onChange, mode, onMode, hint }: Props) {
  const t = useTheme();
  const tr = useT();
  const v3 = useV3();
  const presetsMap = useStore((s) => s.presets);
  const presets = useMemo(() => activePresets(presetsMap), [presetsMap]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');

  const savePreset = async () => {
    const text = value.trim();
    if (!text) { toast(tr('prompt.writeFirst'), 'error'); return; }
    try {
      const p = await api.putPreset(uuid(), { name: name.trim() || text.slice(0, 32), text });
      applyUpsert({ presets: [p] });
      setName('');
      toast(tr('prompt.saved'), 'ok');
    } catch (e: any) { toast(e.message || tr('prompt.saveFailed'), 'error'); }
  };
  const delPreset = async (id: string, n: string) => {
    if (!(await confirmDialog(tr('prompt.deleteTitle'), tr('prompt.deleteMsg', { name: n }), tr('common.delete')))) return;
    try { applyUpsert({ presets: [await api.deletePreset(id)] }); } catch (e: any) { toast(e.message || tr('list.deleteFailed'), 'error'); }
  };

  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
        <Label>{label}</Label>
        {v3 && <Btn small label={tr('prompt.presets', { n: presets.length })} onPress={() => setOpen(true)} />}
      </View>
      <Field value={value} onChangeText={onChange} multiline placeholder={tr('prompt.placeholder')} minHeight={100} />
      {mode !== undefined && onMode && (
        <View style={{ marginTop: 8 }}>
          <Segmented<SystemMode> options={[{ value: 'append', label: tr('prompt.appendMode') }, { value: 'replace', label: tr('prompt.replaceMode') }]} value={mode} onChange={onMode} />
          <Hint>{mode === 'replace' ? tr('prompt.replaceHint') : tr('prompt.appendHint')}</Hint>
        </View>
      )}
      {!!hint && <Hint>{hint}</Hint>}
      <Sheet visible={open} onClose={() => setOpen(false)} title={tr('prompt.presetsTitle')} width={520}>
        {presets.length === 0 && <Text style={{ color: t.sub, paddingVertical: 8 }}>{tr('prompt.noPresets')}</Text>}
        {presets.map((p) => (
          <View key={p.id} style={{ borderBottomWidth: 1, borderColor: t.border, paddingVertical: 8 }}>
            <Text style={{ color: t.text, fontWeight: '600' }}>{p.name}</Text>
            <Text numberOfLines={2} style={{ color: t.sub, fontSize: 12, marginVertical: 3 }}>{p.text}</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Btn small primary label={tr('prompt.use')} onPress={() => { onChange(p.text); setOpen(false); }} />
              {!!value.trim() && <Btn small label={tr('prompt.appendBtn')} onPress={() => { onChange(value.replace(/\s+$/, '') + '\n\n' + p.text); setOpen(false); }} />}
              <Btn small danger label={tr('common.delete')} onPress={() => delPreset(p.id, p.name)} />
            </View>
          </View>
        ))}
        <Label>{tr('prompt.saveLabel')}</Label>
        <Field value={name} onChangeText={setName} placeholder={tr('prompt.presetName')} />
        <View style={{ marginTop: 8 }}><Btn label={tr('prompt.saveBtn')} disabled={!value.trim()} onPress={savePreset} /></View>
      </Sheet>
    </View>
  );
}
