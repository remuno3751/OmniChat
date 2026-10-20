import React, { useMemo, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';
import { Btn, Hint } from '../ui/kit';

const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });
interface Alt { token: string; logprob: number }
interface Row { token: string; logprob: number; top: Alt[] }
const PAGE = 200;

/** Accepts OpenAI `{content:[{token,logprob,top_logprobs}]}`, the bare array, and llama.cpp `completion_probabilities`. */
export function parseLogprobs(raw: any): Row[] {
  let arr: any[] = [];
  if (Array.isArray(raw)) arr = raw;
  else if (Array.isArray(raw?.content)) arr = raw.content;
  else if (Array.isArray(raw?.completion_probabilities)) arr = raw.completion_probabilities;
  const rows: Row[] = [];
  const collect = (e: any) => {
    if (!e || typeof e !== 'object') return;
    const tok = e.token ?? e.content;
    const lp = typeof e.logprob === 'number' ? e.logprob : typeof e.prob === 'number' ? Math.log(Math.max(e.prob, 1e-12)) : null;
    if (typeof tok !== 'string' || lp === null) return;
    const topRaw: any[] = e.top_logprobs || e.top_probs || [];
    const top: Alt[] = topRaw.map((a) => ({ token: String(a.token ?? a.content ?? ''), logprob: typeof a.logprob === 'number' ? a.logprob : Math.log(Math.max(a.prob ?? 1e-12, 1e-12)) }));
    rows.push({ token: tok, logprob: lp, top });
  };
  arr.forEach(collect);
  return rows;
}

const pct = (lp: number) => { const p = Math.exp(lp) * 100; return p >= 10 ? p.toFixed(0) + '%' : p >= 1 ? p.toFixed(1) + '%' : p.toFixed(2) + '%'; };
const show = (s: string) => JSON.stringify(s).slice(1, -1) || '∅';

/** Per-token probability bars from debug `response.logprobs`; tap a row for the top alternatives. */
export default function LogprobsView({ raw }: { raw: any }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const rows = useMemo(() => parseLogprobs(raw), [raw]);
  const [open, setOpen] = useState<number | null>(null);
  const [n, setN] = useState(PAGE);
  if (!rows.length) return <Hint>{tr('sheet.logprobs.unknown')}</Hint>;
  const avg = rows.reduce((a, r) => a + r.logprob, 0) / rows.length;
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={{ color: t.sub, fontSize: 12 }}>{tr('sheet.logprobs.summary', { n: rows.length, p: pct(avg), x: Math.exp(-avg).toFixed(2) })}</Text>
      {rows.slice(0, n).map((r, i) => {
        const p = Math.exp(r.logprob);
        const col = p > 0.8 ? t.good : p > 0.4 ? t.accent : p > 0.15 ? t.warn : t.danger;
        const expanded = open === i;
        return (
          <View key={i}>
            <Pressable onPress={() => setOpen(expanded ? null : i)} accessibilityRole="button" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 3 }}>
              <Text style={{ width: 28, color: t.sub, fontSize: 10, textAlign: 'right' }}>{i + 1}</Text>
              <Text numberOfLines={1} style={{ width: 120, color: t.text, fontFamily: mono, fontSize: 12 }}>{show(r.token)}</Text>
              <View style={[{ flex: 1, height: 8, backgroundColor: t.border, overflow: 'hidden' }, { borderRadius: th.r(4) }]}>
                <View style={{ width: `${Math.max(1, Math.min(100, p * 100))}%`, height: 8, backgroundColor: col }} />
              </View>
              <Text style={{ width: 52, color: t.text, fontSize: 12, textAlign: 'right', fontFamily: mono }}>{pct(r.logprob)}</Text>
            </Pressable>
            {expanded && (
              <View style={{ marginLeft: 36, marginBottom: 6, gap: 2 }}>
                {r.top.length === 0 && <Text style={{ color: t.sub, fontSize: 11 }}>{tr('sheet.logprobs.noAlts')}</Text>}
                {r.top.map((a, k) => (
                  <View key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text numberOfLines={1} style={{ width: 110, color: a.token === r.token ? t.accentInk : t.sub, fontFamily: mono, fontSize: 11 }}>{show(a.token)}</Text>
                    <View style={[{ flex: 1, height: 5, backgroundColor: t.border, overflow: 'hidden' }, { borderRadius: th.r(3) }]}>
                      <View style={{ width: `${Math.max(1, Math.min(100, Math.exp(a.logprob) * 100))}%`, height: 5, backgroundColor: t.sub }} />
                    </View>
                    <Text style={{ width: 52, color: t.sub, fontSize: 11, textAlign: 'right', fontFamily: mono }}>{pct(a.logprob)}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        );
      })}
      {rows.length > n && <View style={{ marginTop: 8 }}><Btn small label={tr('sheet.logprobs.more', { n: rows.length - n })} onPress={() => setN(n + PAGE)} /></View>}
    </View>
  );
}
