import React from 'react';
import { Text, View } from 'react-native';
import type { ResponseFormat } from '../protocol';
import { t as translate, useT } from '../i18n';
import { useTheme } from '../theme';
import Icon from './Icon';
import { Btn, Field, Hint, Label, Segmented } from '../ui/kit';

/** Editor state: the schema stays text while it is being typed. */
export interface RFDraft { mode: 'off' | 'json_object' | 'json_schema'; name: string; schema: string }
export const emptyRF = (): RFDraft => ({ mode: 'off', name: '', schema: '' });

export function rfToDraft(rf: ResponseFormat | null | undefined): RFDraft {
  if (!rf) return emptyRF();
  if (rf.type === 'json_object') return { mode: 'json_object', name: '', schema: '' };
  return { mode: 'json_schema', name: rf.name || '', schema: rf.schema === undefined ? '' : JSON.stringify(rf.schema, null, 2) };
}

/** Parses the schema text; error is '' when the draft is usable. */
export function checkSchema(text: string): { ok: boolean; value?: any; error: string } {
  if (!text.trim()) return { ok: false, error: translate('params.rf.empty') };
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: translate('params.rf.notObject') };
    return { ok: true, value: v, error: '' };
  } catch (e: any) { return { ok: false, error: String(e?.message || e).replace(/^JSON\.parse: /, '') }; }
}

export function draftToRF(d: RFDraft): { value: ResponseFormat | null; error: string } {
  if (d.mode === 'off') return { value: null, error: '' };
  if (d.mode === 'json_object') return { value: { type: 'json_object' }, error: '' };
  const c = checkSchema(d.schema);
  if (!c.ok) return { value: null, error: translate('params.rf.prefix', { error: c.error }) };
  const rf: ResponseFormat = { type: 'json_schema', schema: c.value };
  if (d.name.trim()) (rf as any).name = d.name.trim();
  return { value: rf, error: '' };
}

const EXAMPLE = {
  type: 'object',
  properties: { title: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, score: { type: 'number' } },
  required: ['title', 'tags'],
  additionalProperties: false,
};

/** Response format control: Off / JSON object / JSON schema (monospace editor, live validity, name, example). */
export default function ResponseFormatEditor({ value, onChange, label, hint, compact }: {
  value: RFDraft; onChange: (d: RFDraft) => void; label?: string; hint?: string; compact?: boolean;
}) {
  const t = useTheme();
  const tr = useT();
  const chk = value.mode === 'json_schema' ? checkSchema(value.schema) : null;
  return (
    <View>
      <Label>{label ?? tr('params.rf.label')}</Label>
      <Segmented<RFDraft['mode']>
        options={[{ value: 'off', label: tr('common.off') }, { value: 'json_object', label: tr('params.rf.jsonObject') }, { value: 'json_schema', label: tr('params.rf.jsonSchema') }]}
        value={value.mode}
        onChange={(mode) => onChange({ ...value, mode })}
      />
      {!!hint && !compact && <Hint>{hint}</Hint>}
      {value.mode === 'json_schema' && (
        <View>
          <Field label={tr('params.rf.schemaName')} value={value.name} onChangeText={(name) => onChange({ ...value, name })} placeholder={tr('params.rf.namePh')} />
          <Field label={tr('params.rf.jsonSchema')} value={value.schema} onChangeText={(schema) => onChange({ ...value, schema })} multiline minHeight={140} mono placeholder='{ "type": "object", "properties": { ... } }' />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
            {chk && (
              <View accessibilityLabel={chk.ok ? tr('params.rf.validA11y') : tr('params.rf.invalidA11y')} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 }}>
                <Icon name={chk.ok ? 'check' : 'error'} size={14} color={chk.ok ? t.good : t.danger} />
                <Text style={{ color: chk.ok ? t.good : t.danger, fontSize: 12, flexShrink: 1 }}>{chk.ok ? tr('params.validJson') : chk.error}</Text>
              </View>
            )}
            <Btn small label={tr('params.rf.insertExample')} onPress={() => onChange({ ...value, name: value.name || 'answer', schema: JSON.stringify(EXAMPLE, null, 2) })} />
          </View>
        </View>
      )}
    </View>
  );
}
