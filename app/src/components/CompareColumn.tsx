import React, { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { prettyJson } from '../devState';
import type { CompareCol } from '../devState';
import type { Metrics } from '../protocol';
import { useTheme, useThemeDef } from '../theme';
import { useT } from '../i18n';
import { copyText } from '../ui/clipboard';
import { Btn } from '../ui/kit';
import { toast } from '../ui/toast';
import JsonBadge from './JsonBadge';
import Icon from './Icon';
import { fmtMs, fmtTps } from './MetricsLine';

const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

/** Column index holding the fastest value per metric (null = fewer than two comparable values). */
export interface Best { ttft: number | null; prefill: number | null; decode: number | null }

export function bestOf(cols: { status: string; metrics: Metrics | null }[]): Best {
  const pick = (get: (m: Metrics) => number | null | undefined, higherBetter: boolean): number | null => {
    const vals: { i: number; v: number }[] = [];
    for (let i = 0; i < cols.length; i++) {
      const m = cols[i].metrics;
      const v = cols[i].status === 'done' && m ? get(m) : null;
      if (v != null && Number.isFinite(v)) vals.push({ i, v });
    }
    if (vals.length < 2) return null;
    let win = vals[0];
    for (const x of vals) if (higherBetter ? x.v > win.v : x.v < win.v) win = x;
    return win.i;
  };
  return {
    ttft: pick((m) => m.ttftMs, false),
    prefill: pick((m) => m.prefillTps, true),
    decode: pick((m) => m.decodeTps, true),
  };
}

/** Translated status word; `error` and `stopped` reuse the message-status keys. */
const statusKey: Record<CompareCol['status'], string> = { waiting: 'compare.status.waiting', running: 'compare.status.running', done: 'compare.status.done', error: 'msg.statusError', stopped: 'msg.statusStopped' };

function Cell({ label, value, best }: { label: string; value: string; best?: boolean }) {
  const t = useTheme();
  const tr = useT();
  return (
    <View style={{ minWidth: 70, flexGrow: 1 }}>
      <Text style={{ color: t.sub, fontSize: 10, textTransform: 'uppercase' }}>{label}</Text>
      <Text accessibilityLabel={`${label} ${value}${best ? ` ${tr('compare.fastest')}` : ''}`} style={{ color: best ? t.good : t.text, fontWeight: best ? '800' : '500', fontSize: 13, fontFamily: mono }}>
        {value}{best ? <Icon name="star" size={12} color={t.good} /> : null}
      </Text>
    </View>
  );
}

/** One model's answer in a comparison: status, collapsed thinking, text (pretty JSON when valid), metrics, copy. */
export default function CompareColumn({ label, col, best, index, flex }: { label: string; col: CompareCol; best: Best; index: number; flex?: boolean }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const [thinking, setThinking] = useState(false);
  const m = col.metrics;
  const json = m?.jsonValid ? prettyJson(col.content) : null;
  const copy = async () => toast((await copyText(col.content)) ? tr('msg.copied') : tr('msg.copyFailed'), 'ok');
  const sc = col.status === 'done' ? t.good : col.status === 'error' ? t.danger : t.sub;
  const statusWord = tr(statusKey[col.status]);
  return (
    <View style={{ flex: flex ? 1 : undefined, minWidth: 0, borderWidth: 1, borderColor: t.border, borderRadius: th.r(12), padding: 10, backgroundColor: t.panel }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text numberOfLines={2} style={{ flex: 1, color: t.text, fontWeight: '700', fontSize: 14 }}>{label}</Text>
        <Text accessibilityLabel={`${tr('compare.statusLabel')} ${statusWord}`} style={{ color: sc, fontSize: 12, fontWeight: '600' }}>{statusWord}</Text>
      </View>
      {!!col.reasoning && (
        <Pressable onPress={() => setThinking(!thinking)} accessibilityRole="button" style={{ marginTop: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Icon name={thinking ? 'expand' : 'chevronRight'} size={16} color={t.sub} />
            <Text style={{ color: t.sub, fontSize: 12 }}>{tr('compare.thinking', { n: col.reasoning.length })}</Text>
          </View>
        </Pressable>
      )}
      {thinking && !!col.reasoning && (
        <ScrollView style={{ maxHeight: 180, marginTop: 4 }} nestedScrollEnabled>
          <Text selectable style={{ color: t.sub, fontSize: 12, fontStyle: 'italic', lineHeight: 17 }}>{col.reasoning}</Text>
        </ScrollView>
      )}
      <ScrollView style={{ maxHeight: 420, marginTop: 8, minHeight: 60 }} nestedScrollEnabled>
        {col.status === 'waiting' && <Text style={{ color: t.sub, fontSize: 13 }}>{tr('compare.waitTurn')}</Text>}
        {col.status === 'running' && !col.content && <ActivityIndicator color={t.accentInk} style={{ alignSelf: 'flex-start' }} />}
        {json ? (
          <View style={{ borderRadius: th.r(8), padding: 10, backgroundColor: t.code }}>
            <Text selectable style={{ color: t.codeText, fontFamily: mono, fontSize: 12 }}>{json}</Text>
          </View>
        ) : (
          !!col.content && <Text selectable style={{ color: t.text, fontSize: 14, lineHeight: 20 }}>{col.content}</Text>
        )}
        {!!col.error && <Text style={{ color: t.danger, marginTop: 6, fontSize: 13 }}>{col.error}</Text>}
        {col.status === 'stopped' && <Text style={{ color: t.sub, fontSize: 12, marginTop: 4 }}>{tr('msg.statusStopped')}</Text>}
      </ScrollView>
      {!!m && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderColor: t.border }}>
          <Cell label="TTFT" value={fmtMs(m.ttftMs)} best={best.ttft === index} />
          <Cell label="prefill tok/s" value={fmtTps(m.prefillTps)} best={best.prefill === index} />
          <Cell label="decode tok/s" value={fmtTps(m.decodeTps)} best={best.decode === index} />
          <Cell label={tr('compare.tokens')} value={m.completionTokens != null ? `${m.completionTokens}${m.reasoningTokens ? ` (+${m.reasoningTokens})` : ''}` : '-'} />
        </View>
      )}
      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
        {m?.source === 'estimated' && (
          <View style={{ borderWidth: 1, borderColor: t.warn, borderRadius: th.r(6), paddingHorizontal: 5 }}>
            <Text style={{ color: t.warn, fontSize: 11, fontWeight: '700' }} accessibilityLabel={tr('compare.estimated')}>{tr('compare.est')}</Text>
          </View>
        )}
        <JsonBadge metrics={m} />
        {!!col.content && <Btn small label={tr('common.copy')} onPress={copy} />}
      </View>
    </View>
  );
}
