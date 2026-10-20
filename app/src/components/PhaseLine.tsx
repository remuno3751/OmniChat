import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Message, PhaseRecord } from '../protocol';
import { useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';
import { LoadBar, NodeTrack, type Step } from '../ui/skin';
import Icon from './Icon';

type Tr = (key: string, vars?: Record<string, string | number>) => string;

const STEP_KEYS: Record<string, string> = {
  thinking: 'phase.step.thinking', searching: 'phase.step.searching', tool: 'phase.step.tool', subagent: 'phase.step.subagent', answering: 'phase.step.answering',
};
const pad = (n: number) => String(n).padStart(2, '0');

/** Text for one staged-status record (known phases go through i18n; unknown labels are shown as-is). */
function phaseText(p: PhaseRecord, tr: Tr): string {
  switch (p.phase) {
    case 'thinking': return tr('phase.thinking');
    case 'searching': return p.label ? tr('phase.searching', { label: p.label }) : tr('phase.searchingNoLabel');
    case 'tool': return tr('phase.tool', { label: p.label || tr('msg.phase.toolFallback') });
    case 'subagent': return tr('phase.subagent');
    case 'answering': return tr('phase.answering');
    default: return p.label || String(p.phase);
  }
}

/**
 * Staged status of an assistant reply: one live line while streaming, plus a collapsed
 * history of the finished steps (durations in seconds). Hidden without phases.
 */
export default function PhaseLine({ m }: { m: Message }) {
  const t = useTheme();
  const th = useThemeDef();
  const pv = th.def.variants.phase;
  const tr = useT();
  const [open, setOpen] = useState(false);
  const phases = m.phases ?? [];
  if (!phases.length || phases.every((p) => p.phase === 'answering')) return null;

  const streaming = m.status === 'streaming';
  const current = streaming ? [...phases].reverse().find((p) => p.end === null) ?? phases[phases.length - 1] : null;
  const finished = phases.filter((p) => p.end !== null);
  // themed staged views: one step per distinct phase kind, in order, plus the final "answering" step
  const steps: Step[] = [];
  if (current && pv !== 'plain') {
    for (const p of phases) {
      const key = String(p.phase);
      const st: Step['state'] = p === current ? 'current' : p.end !== null ? 'done' : 'todo';
      const prev = steps.find((x) => x.key === key);
      if (prev) { if (st === 'current') prev.state = 'current'; continue; }
      steps.push({ key, label: tr(STEP_KEYS[key] ?? 'phase.step.other'), state: st });
    }
    if (!steps.some((x) => x.key === 'answering')) steps.push({ key: 'answering', label: tr('phase.step.answering'), state: 'todo' });
  }
  const curIdx = Math.max(0, steps.findIndex((x) => x.state === 'current'));

  return (
    <View style={styles.wrap}>
      {current && pv === 'loading' && (
        <View style={styles.liveBlock}>
          <LoadBar value={(curIdx + 0.5) / steps.length} label={phaseText(current, tr)} counter={`${pad(curIdx + 1)}/${pad(steps.length)}`} />
        </View>
      )}
      {current && pv === 'nodes' && (
        <View style={styles.liveBlock}>
          <NodeTrack steps={steps} />
          <Text style={{ color: t.sub, fontSize: 12, marginTop: 4 }}>{phaseText(current, tr)}</Text>
        </View>
      )}
      {current && pv === 'plain' && (
        <View style={styles.live}>
          <ActivityIndicator size="small" color={t.accentInk} style={{ transform: [{ scale: 0.7 }] }} />
          <Text style={{ color: t.sub, fontSize: 13, flexShrink: 1 }}>{phaseText(current, tr)}</Text>
        </View>
      )}
      {finished.length >= 1 && (
        <>
          <Pressable
            onPress={() => setOpen(!open)}
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            accessibilityLabel={tr('phase.history', { count: finished.length })}
            style={styles.head}
          >
            <Icon name={open ? 'expand' : 'chevronRight'} size={16} color={t.sub} />
            <Text style={{ color: t.sub, fontSize: 12, fontWeight: '600', flexShrink: 1 }}>{tr('phase.history', { count: finished.length })}</Text>
          </Pressable>
          {open && (
            <View style={styles.list}>
              {finished.map((p, i) => (
                <Text key={`${p.id}-${i}`} style={{ color: t.sub, fontSize: 13, lineHeight: 19 }}>
                  {phaseText(p, tr)} · {tr('msg.secs', { n: (((p.end as number) - p.start) / 1000).toFixed(1) })}
                </Text>
              ))}
            </View>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 6 },
  live: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 },
  liveBlock: { paddingVertical: 4, marginBottom: 2 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 },
  list: { borderLeftWidth: 2, paddingLeft: 8, marginTop: 2, marginLeft: 8 },
});
