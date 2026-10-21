import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiError, api } from '../api';
import { useDevice } from '../deviceSettings';
import { resolveLanguage, useT } from '../i18n';
import type { UsageChats, UsageDaily, UsageModels, UsageSummary } from '../protocol';
import { useTheme, useThemeDef } from '../theme';
import { Hint, ScreenHeader, Segmented } from '../ui/kit';
import LineChart from '../components/LineChart';
import UsageHeatmap from '../components/UsageHeatmap';
import {
  dayLabel,
  formatTokens,
  niceMax,
  periodDays,
  periodRange,
  segmentHeights,
  sharePct,
  shortDate,
  tzOffsetMinutes,
  type UsageLang,
  type UsagePeriodKey,
} from '../usageFormat';

/** Plot height of the daily chart (px). */
const CH = 160;
/** Width of the y-axis column (px). */
const AXIS_W = 46;
/** Bar width and gap in scroll mode (px); a slot is one bar plus its gap. */
const BAR_W = 10;
const SLOT = BAR_W + 3;
/** More days than this: the chart scrolls horizontally instead of squeezing the bars. */
const SCROLL_AT = 35;

interface UsageData { summary: UsageSummary; daily: UsageDaily; chats: UsageChats; models: UsageModels }

/** Settings > Statistics > Usage: token totals, a daily stacked chart, the top chats and the per-model split. */
export default function UsageScreen({ onBack, onOpenChat }: { onBack: () => void; onOpenChat?: (id: string) => void }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const lang: UsageLang = resolveLanguage(useDevice((s) => s.language)) === 'ja' ? 'ja' : 'en';
  const [period, setPeriod] = useState<UsagePeriodKey>('30d');
  const [data, setData] = useState<UsageData | null>(null);
  const [err, setErr] = useState('');
  /** index of the selected day bar (null = none) */
  const [sel, setSel] = useState<number | null>(null);
  /** daily chart: stacked bars or lines */
  const [kind, setKind] = useState<'bar' | 'line'>('bar');
  /** the last 26 weeks for the heat map (independent of the chosen period) */
  const [heat, setHeat] = useState<UsageDaily['days'] | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  /** ignores answers of a period that is no longer shown */
  const seq = useRef(0);

  useEffect(() => {
    const my = ++seq.current;
    setData(null); setErr(''); setSel(null);
    const tz = tzOffsetMinutes();
    const from = periodRange(period, Date.now(), tz).from ?? undefined;
    Promise.all([
      api.usageSummary({ from, tz }),
      api.usageDaily(periodDays(period), tz),
      api.usageChats({ from, limit: 10 }),
      api.usageModels({ from }),
    ]).then(([summary, daily, chats, models]) => {
      if (my === seq.current) setData({ summary, daily, chats, models });
    }).catch((e: any) => {
      if (my !== seq.current) return;
      setErr(e instanceof ApiError && (e.status === 404 || e.status === 501) ? tr('usage.noServer') : tr('usage.error', { msg: e?.message || String(e) }));
    });
  }, [period, tr]);

  useEffect(() => {
    let alive = true;
    api.usageDaily(182, tzOffsetMinutes()).then((r) => { if (alive) setHeat(r.days); }).catch(() => { if (alive) setHeat(null); });
    return () => { alive = false; };
  }, []);

  const summary = data?.summary;
  const totals = summary?.totals;
  const tz = summary?.tz ?? 0;
  const days = useMemo(() => data?.daily.days ?? [], [data]);
  const n = days.length;
  const scroll = n > SCROLL_AT;
  const yMax = niceMax(days.reduce((m, d) => Math.max(m, d.totalTokens), 0));
  const bars = useMemo(() => days.map((d) => segmentHeights(d, yMax, CH)), [days, yMax]);
  /** x labels: every `step` days, anchored so the newest day is always labelled */
  const step = n <= 8 ? 1 : scroll ? Math.ceil(n / 6) : 7;
  const isLabel = (i: number) => (n - 1 - i) % step === 0;
  const estimated = !!data && (data.summary.estimated || data.daily.estimated || data.chats.estimated || data.models.estimated);
  const empty = !!totals && totals.messages === 0;

  // segment colours: input = accent, output = accent2 (or grey where it equals the accent), thinking = warn (or red where it equals output)
  const cIn = t.accent;
  const cOut = t.accent2 !== t.accent ? t.accent2 : t.sub;
  const cThink = t.warn !== cOut ? t.warn : t.danger;
  const legend = [
    { c: cIn, l: tr('usage.legend.in') },
    { c: cOut, l: tr('usage.legend.out') },
    { c: cThink, l: tr('usage.legend.reasoning') },
  ];

  const detail = (d: UsageDaily['days'][number]) => tr('usage.barDetail', {
    day: dayLabel(d.day, lang),
    total: formatTokens(d.totalTokens),
    in: formatTokens(d.promptTokens),
    out: formatTokens(Math.max(0, d.completionTokens - d.reasoningTokens)),
    reasoning: formatTokens(d.reasoningTokens),
    messages: d.messages,
  });

  /** position of the x label of day i (fixed px in scroll mode, percent of the plot otherwise) */
  const labelBox = (i: number): any => {
    if (scroll) {
      const cell = step * SLOT;
      return { left: Math.max(0, i * SLOT + BAR_W / 2 - cell / 2), width: cell };
    }
    const w = step / n;
    const left = Math.min(Math.max(0, (i + 0.5) / n - w / 2), 1 - w);
    return { left: `${left * 100}%`, width: `${w * 100}%` };
  };

  const plot = (
    <View style={{ height: CH }}>
      {[1, 2, 3].map((k) => (
        <View key={k} pointerEvents="none" style={[styles.grid, { top: CH - (k / 3) * CH, backgroundColor: t.border }]} />
      ))}
      <View style={styles.barRow}>
        {days.map((d, i) => {
          const b = bars[i];
          const on = sel === i;
          return (
            <Pressable
              key={d.day}
              onPress={() => setSel(on ? null : i)}
              accessibilityRole="button"
              accessibilityLabel={detail(d)}
              accessibilityState={{ selected: on }}
              style={[styles.slot, scroll ? { width: SLOT } : { flex: 1 }, on && { backgroundColor: t.panel2, borderRadius: 3 }]}
            >
              <View style={{ width: scroll ? BAR_W : '70%', maxWidth: 28, height: '100%', justifyContent: 'flex-end' }}>
                <View style={{ height: b.thinking, backgroundColor: cThink }} />
                <View style={{ height: b.output, backgroundColor: cOut }} />
                <View style={{ height: b.input, backgroundColor: cIn }} />
              </View>
            </Pressable>
          );
        })}
      </View>
      <View style={[styles.grid, { top: CH - 1, backgroundColor: t.borderStrong }]} />
    </View>
  );
  const xLabels = (
    <View style={{ height: 16 }}>
      {days.map((d, i) => isLabel(i) ? (
        <Text key={d.day} numberOfLines={1} style={[styles.xl, labelBox(i), { color: t.sub }]}>{dayLabel(d.day, lang)}</Text>
      ) : null)}
    </View>
  );
  const chart = (
    <View style={{ flexDirection: 'row' }}>
      <View style={{ width: AXIS_W, height: CH }}>
        {[1, 2, 3].map((k) => (
          <Text key={k} numberOfLines={1} style={[styles.axis, { bottom: (k / 3) * CH - 7, color: t.sub }]}>{formatTokens((yMax * k) / 3)}</Text>
        ))}
      </View>
      {scroll ? (
        <ScrollView
          ref={scrollRef}
          horizontal
          showsHorizontalScrollIndicator
          style={{ flex: 1 }}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
        >
          <View style={{ width: n * SLOT }}>{plot}{xLabels}</View>
        </ScrollView>
      ) : (
        <View style={{ flex: 1 }}>{plot}{xLabels}</View>
      )}
    </View>
  );

  const chats = data?.chats.chats ?? [];
  const maxChat = chats.reduce((m, c) => Math.max(m, c.totalTokens), 0);
  const models = data?.models.models ?? [];
  const barPct = (v: number, max: number) => (v > 0 && max > 0 ? Math.min(100, Math.max(2, Math.round((v / max) * 100))) : 0);

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <ScreenHeader title={tr('usage.title')} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.body}>
        <Segmented<UsagePeriodKey>
          options={[
            { value: '7d', label: tr('usage.period.7d') },
            { value: '30d', label: tr('usage.period.30d') },
            { value: '90d', label: tr('usage.period.90d') },
            { value: 'all', label: tr('usage.period.all') },
          ]}
          value={period}
          onChange={setPeriod}
        />
        {!data && !err && <ActivityIndicator color={t.accentInk} style={{ margin: 20 }} />}
        {!!err && <Hint danger>{err}</Hint>}
        {!!data && empty && <Hint>{tr('usage.empty')}</Hint>}

        {!!data && !empty && totals && (
          <>
            <View style={styles.kpis}>
              {[
                { k: 'total', label: tr('usage.kpi.total'), value: formatTokens(totals.totalTokens), raw: totals.totalTokens },
                { k: 'messages', label: tr('usage.kpi.messages'), value: String(totals.messages), raw: totals.messages },
                { k: 'chats', label: tr('usage.kpi.chats'), value: String(totals.chats), raw: totals.chats },
                { k: 'avg', label: tr('usage.kpi.avg'), value: formatTokens(totals.avgTokensPerAnswer), raw: totals.avgTokensPerAnswer },
              ].map((kpi) => (
                <View
                  key={kpi.k}
                  accessible
                  accessibilityLabel={`${kpi.label}: ${kpi.raw}`}
                  style={[styles.card, styles.kpi, { borderRadius: th.r(12), borderColor: t.border, backgroundColor: t.panel }]}
                >
                  <Text numberOfLines={1} style={{ color: t.sub, fontSize: 12 }}>{kpi.label}</Text>
                  <Text numberOfLines={1} style={{ color: t.text, fontSize: 22, fontWeight: '700', marginTop: 4 }}>{kpi.value}</Text>
                </View>
              ))}
            </View>
            {estimated && <Hint>{tr('usage.estimatedNote')}</Hint>}

            <Text style={[styles.section, { color: t.text }]}>{tr('usage.daily')}</Text>
            <Segmented<'bar' | 'line'>
              options={[{ value: 'bar', label: tr('usage.kind.bar') }, { value: 'line', label: tr('usage.kind.line') }]}
              value={kind}
              onChange={setKind}
            />
            <View style={[styles.card, { borderRadius: th.r(12), borderColor: t.border, backgroundColor: t.panel, marginTop: 8 }]}>
              {n > 0 && kind === 'bar' && chart}
              {n > 0 && kind === 'line' && (
                <LineChart
                  title={tr('usage.daily')}
                  series={[
                    { name: tr('usage.legend.in'), color: cIn, unit: '', points: days.map((d) => d.promptTokens) },
                    { name: tr('usage.legend.out'), color: cOut, unit: '', points: days.map((d) => Math.max(0, d.completionTokens - d.reasoningTokens)) },
                    { name: tr('usage.legend.reasoning'), color: cThink, unit: '', points: days.map((d) => d.reasoningTokens) },
                  ]}
                />
              )}
              {kind === 'bar' && <View style={styles.legend}>
                {legend.map((x) => (
                  <View key={x.l} style={styles.legendItem}>
                    <View style={[styles.swatch, { backgroundColor: x.c }]} />
                    <Text style={{ color: t.sub, fontSize: 12 }}>{x.l}</Text>
                  </View>
                ))}
              </View>}
              {sel != null && days[sel] && <Text style={{ color: t.text, fontSize: 12, marginTop: 8 }}>{detail(days[sel])}</Text>}
            </View>

            {!!heat && heat.some((d) => d.totalTokens > 0) && (
              <>
                <Text style={[styles.section, { color: t.text }]}>{tr('usage.heat')}</Text>
                <View style={[styles.card, { borderRadius: th.r(12), borderColor: t.border, backgroundColor: t.panel }]}>
                  <UsageHeatmap days={heat} />
                  <Hint>{tr('usage.heat.hint')}</Hint>
                </View>
              </>
            )}

            {chats.length > 0 && (
              <>
                <Text style={[styles.section, { color: t.text }]}>{tr('usage.topChats')}</Text>
                <View style={[styles.card, { borderRadius: th.r(12), borderColor: t.border, backgroundColor: t.panel }]}>
                  {chats.map((c, i) => {
                    const title = c.title || tr('usage.noTitle');
                    const last = shortDate(c.lastActivity, tz, lang);
                    const inner = (
                      <>
                        <View style={styles.rowTop}>
                          <Text numberOfLines={1} style={{ flex: 1, color: t.text, fontSize: 14, fontWeight: '600' }}>{title}</Text>
                          <Text style={{ color: t.text, fontSize: 13, marginLeft: 8 }}>{formatTokens(c.totalTokens)}</Text>
                        </View>
                        {c.models.length > 0 && <Text numberOfLines={1} style={{ color: t.sub, fontSize: 11, marginTop: 2 }}>{c.models.join(', ')}</Text>}
                        <Text numberOfLines={1} style={{ color: t.sub, fontSize: 11, marginTop: 2 }}>{tr('usage.chatRow', { messages: c.messages, last })}</Text>
                        <View style={[styles.track, { backgroundColor: t.border }]}>
                          <View style={{ height: 4, width: `${barPct(c.totalTokens, maxChat)}%`, backgroundColor: t.accent }} />
                        </View>
                      </>
                    );
                    const rowStyle = [styles.row, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: t.border }];
                    return onOpenChat ? (
                      <Pressable
                        key={c.conversationId}
                        onPress={() => onOpenChat(c.conversationId)}
                        accessibilityRole="button"
                        accessibilityLabel={`${title}, ${formatTokens(c.totalTokens)}`}
                        style={rowStyle}
                      >{inner}</Pressable>
                    ) : (
                      <View key={c.conversationId} style={rowStyle}>{inner}</View>
                    );
                  })}
                </View>
              </>
            )}

            {models.length > 0 && (
              <>
                <Text style={[styles.section, { color: t.text }]}>{tr('usage.byModel')}</Text>
                <View style={[styles.card, { borderRadius: th.r(12), borderColor: t.border, backgroundColor: t.panel }]}>
                  {models.map((m, i) => {
                    const name = m.model || '-';
                    const label = m.providerName ? `${name} (${m.providerName})` : name;
                    const share = Math.min(1, Math.max(0, Number.isFinite(m.share) ? m.share : 0));
                    return (
                      <View key={`${m.providerId ?? ''}|${name}|${i}`} style={[styles.row, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: t.border }]}>
                        <View style={styles.rowTop}>
                          <Text numberOfLines={1} style={{ flex: 1, color: t.text, fontSize: 14, fontWeight: '600' }}>{label}</Text>
                          <Text style={{ color: t.text, fontSize: 13, marginLeft: 8 }}>{formatTokens(m.totalTokens)}</Text>
                        </View>
                        <Text style={{ color: t.sub, fontSize: 11, marginTop: 2 }}>{sharePct(m.share)}</Text>
                        <View style={[styles.track, { backgroundColor: t.border }]}>
                          <View style={{ height: 4, width: `${share > 0 ? Math.max(2, Math.round(share * 100)) : 0}%`, backgroundColor: t.accent }} />
                        </View>
                      </View>
                    );
                  })}
                </View>
              </>
            )}
          </>
        )}
        <Hint>{tr('usage.ephNote')}</Hint>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { padding: 16, gap: 2, width: '100%', maxWidth: 720, alignSelf: 'center' },
  section: { fontSize: 16, fontWeight: '700', marginTop: 20 },
  card: { borderWidth: 1, padding: 12 },
  kpis: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 },
  kpi: { flexGrow: 1, flexBasis: 150 },
  grid: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth },
  barRow: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, flexDirection: 'row' },
  slot: { height: '100%', alignItems: 'center', justifyContent: 'flex-end' },
  xl: { position: 'absolute', top: 2, fontSize: 10, textAlign: 'center' },
  axis: { position: 'absolute', right: 6, fontSize: 10 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 10 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swatch: { width: 10, height: 10, borderRadius: 2 },
  row: { paddingVertical: 8 },
  rowTop: { flexDirection: 'row', alignItems: 'center' },
  track: { height: 4, borderRadius: 2, overflow: 'hidden', marginTop: 6 },
});
