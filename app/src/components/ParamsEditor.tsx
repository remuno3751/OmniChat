import React from 'react';
import { Text, View } from 'react-native';
import type { SamplingParams } from '../protocol';
import { t as translate, useT } from '../i18n';
import type { Vars } from '../i18n';
import { Field, Hint, Label } from '../ui/kit';
import { isReservedKey, useDevAvail } from '../devState';
import { useTheme } from '../theme';
import Icon from './Icon';

/** Draft form state: every field is a string; '' = inherit. */
export interface ParamsDraft { temperature: string; topP: string; topK: string; minP: string; repeatPenalty: string; seed: string; maxTokens: string; stop: string; logprobs: string; grammar: string; extraBody: string }

export const emptyParams = (): ParamsDraft => ({ temperature: '', topP: '', topK: '', minP: '', repeatPenalty: '', seed: '', maxTokens: '', stop: '', logprobs: '', grammar: '', extraBody: '' });

export function paramsToDraft(p: SamplingParams | null | undefined): ParamsDraft {
  const s = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));
  return {
    temperature: s(p?.temperature), topP: s(p?.topP), topK: s(p?.topK), minP: s(p?.minP), repeatPenalty: s(p?.repeatPenalty),
    seed: s(p?.seed), maxTokens: s(p?.maxTokens), stop: (p?.stop || []).join('\n'),
    logprobs: s(p?.logprobs), grammar: p?.grammar || '',
    extraBody: p?.extraBody && Object.keys(p.extraBody).length ? JSON.stringify(p.extraBody, null, 2) : '',
  };
}

/** Draft -> params (null when everything inherits). Non-numeric input becomes inherit. */
export function draftToParams(d: ParamsDraft): SamplingParams | null {
  const num = (v: string): number | null => { const x = parseFloat(v.replace(',', '.')); return v.trim() !== '' && Number.isFinite(x) ? x : null; };
  const int = (v: string): number | null => { const x = num(v); return x === null ? null : Math.trunc(x); };
  const stops = d.stop.split('\n').filter((x) => x !== '');
  const p: SamplingParams = {
    temperature: num(d.temperature), topP: num(d.topP), topK: int(d.topK), minP: num(d.minP), repeatPenalty: num(d.repeatPenalty),
    seed: int(d.seed), maxTokens: int(d.maxTokens), stop: stops.length ? stops : null,
  };
  // phase 4 (only set when used, so an old server never sees the keys)
  const lp = int(d.logprobs);
  if (lp !== null) p.logprobs = Math.max(0, Math.min(20, lp));
  if (d.grammar.trim()) p.grammar = d.grammar;
  const eb = parseExtraBody(d.extraBody);
  if (eb.value) p.extraBody = eb.value;
  return Object.values(p).some((v) => v !== null) ? p : null;
}

type Tr = (key: string, vars?: Vars) => string;

/** Sampling fields. Top P / Top K / Min P are sampler names and stay as they are. */
function paramFields(tr: Tr): { key: keyof ParamsDraft; label: string; ph: string }[] {
  return [
    { key: 'temperature', label: tr('params.temperature'), ph: tr('params.ph.inheritEg', { v: '0.7' }) },
    { key: 'topP', label: 'Top P', ph: tr('params.ph.inheritEg', { v: '0.95' }) },
    { key: 'topK', label: 'Top K', ph: tr('params.ph.inheritEg', { v: '40' }) },
    { key: 'minP', label: 'Min P', ph: tr('params.ph.inheritEg', { v: '0.05' }) },
    { key: 'repeatPenalty', label: tr('params.repeatPenalty'), ph: tr('params.ph.inheritEg', { v: '1.1' }) },
    { key: 'seed', label: tr('params.seed'), ph: tr('params.ph.seedRandom') },
    { key: 'maxTokens', label: tr('params.maxTokens'), ph: tr('params.ph.inherit') },
  ];
}

/** extraBody text -> object ('' = unset). */
export function parseExtraBody(text: string): { value: Record<string, any> | null; error: string } {
  if (!text.trim()) return { value: null, error: '' };
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { value: null, error: translate('params.errNotObject') };
    return { value: Object.keys(v).length ? v : null, error: '' };
  } catch (e: any) { return { value: null, error: String(e?.message || e).replace(/^JSON.parse: /, '') }; }
}

export default function ParamsEditor({ value, onChange, inheritFrom }: { value: ParamsDraft; onChange: (d: ParamsDraft) => void; inheritFrom: string }) {
  const tr = useT();
  const ext = useDevAvail('any');
  return (
    <View>
      <Label>{tr('params.sampling')}</Label>
      <Hint>{tr('params.inheritHint', { from: inheritFrom })}</Hint>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 10 }}>
        {paramFields(tr).map((f) => (
          <View key={f.key} style={{ flexGrow: 1, flexBasis: 150, minWidth: 140 }}>
            <Field label={f.label} value={value[f.key]} placeholder={f.ph} keyboardType="numeric" onChangeText={(v) => onChange({ ...value, [f.key]: v })} />
          </View>
        ))}
      </View>
      <Field label={tr('params.stop')} value={value.stop} placeholder={tr('params.ph.inherit')} multiline minHeight={56} mono onChangeText={(v) => onChange({ ...value, stop: v })} />
      {ext && <AdvancedParams value={value} onChange={onChange} />}
    </View>
  );
}

/** Phase 4 additions: logprobs (top-N), grammar (llama.cpp GBNF) and extraBody (JSON merged into the request body). */
function AdvancedParams({ value, onChange }: { value: ParamsDraft; onChange: (d: ParamsDraft) => void }) {
  const t = useTheme();
  const tr = useT();
  const eb = parseExtraBody(value.extraBody);
  const reserved = eb.value ? Object.keys(eb.value).filter(isReservedKey) : [];
  const lp = parseInt(value.logprobs, 10);
  return (
    <View>
      <Field label={tr('params.logprobs')} value={value.logprobs} placeholder={tr('params.ph.inheritOff')} keyboardType="numeric" onChangeText={(v) => onChange({ ...value, logprobs: v })} />
      {Number.isFinite(lp) && (lp < 0 || lp > 20) && <Hint danger>{tr('params.logprobsRange')}</Hint>}
      {value.logprobs.trim() !== '' && <Hint>{tr('params.logprobsStored')}</Hint>}
      <Field label={tr('params.grammar')} value={value.grammar} placeholder={tr('params.ph.inheritNone')} multiline minHeight={70} mono onChangeText={(v) => onChange({ ...value, grammar: v })} />
      <Field label={tr('params.extraBody')} value={value.extraBody} placeholder={tr('params.ph.extraBody')} multiline minHeight={70} mono onChangeText={(v) => onChange({ ...value, extraBody: v })} />
      {!!value.extraBody.trim() && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
          <Icon name={eb.error ? 'error' : 'check'} size={14} color={eb.error ? t.danger : t.good} />
          <Text style={{ color: eb.error ? t.danger : t.good, fontSize: 12, flexShrink: 1 }}>{eb.error ? tr('params.errIgnored', { error: eb.error }) : tr('params.validJson')}</Text>
        </View>
      )}
      {reserved.length > 0 && <Hint danger>{tr('params.reserved', { keys: reserved.join(', ') })}</Hint>}
      <Hint>{tr('params.mergeNote')}</Hint>
    </View>
  );
}
