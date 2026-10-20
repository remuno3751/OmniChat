import React from 'react';
import { Text, View } from 'react-native';
import { useT } from '../i18n';
import type { ContextOverflow } from '../protocol';
import { OVERFLOW_ORDER, indexToOverflow, overflowToIndex } from '../overflowSteps';
import type { ChatOverflow } from '../overflowSteps';
import { useTheme } from '../theme';
import { Hint } from '../ui/kit';
import SliderField from '../ui/SliderField';

/** Stepped slider for the context-overflow policy. `withDefault` adds the leading "follow default" step (per-chat use). */
export default function OverflowSlider({ value, onChange, withDefault, label }: {
  value: ChatOverflow;
  onChange: (v: ChatOverflow) => void;
  withDefault?: boolean;
  label: string;
}) {
  const tr = useT();
  const t = useTheme();
  const wd = !!withDefault;
  const name = (v: ChatOverflow) => (v == null ? tr('set.ctx.followDefault') : tr(`composer.context.overflow.${v}`));
  const steps: ChatOverflow[] = wd ? [null, ...OVERFLOW_ORDER] : [...OVERFLOW_ORDER];
  const help: Record<ContextOverflow, string> = {
    truncate: tr('set.ctx.helpTruncate'),
    summarize: tr('set.ctx.helpSummarize'),
    stop: tr('set.ctx.helpStop'),
  };
  return (
    <>
      <SliderField
        label={label}
        value={overflowToIndex(value, wd)}
        min={0}
        max={wd ? 3 : 2}
        step={1}
        onChange={(i) => onChange(indexToOverflow(i, wd))}
        format={(i) => name(indexToOverflow(i, wd))}
      />
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 }}>
        {steps.map((s, i) => (
          <Text key={String(s ?? 'default') + i} style={{ color: s === value ? t.text : t.sub, fontSize: 11, fontWeight: s === value ? '700' : '400' }}>{name(s)}</Text>
        ))}
      </View>
      <Hint>{value == null ? tr('set.ctx.helpFollow') : help[value]}</Hint>
    </>
  );
}
