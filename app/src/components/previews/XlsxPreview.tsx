import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { computeGrid, type GridCell } from '../../sheetEval';
import { colLetter, parseSheets } from '../../sheetModel';
import { sheetCharts } from '../../sheetCharts';
import ChartBlock from '../ChartBlock';
import { useT } from '../../i18n';
import { useThemeDef, useTheme } from '../../theme';

/*
 * Preview of an xlsx artifact: one tab per sheet, a grid with column letters and row numbers, values from
 * computeGrid (formulas are evaluated when supported, otherwise shown as text with an "fx" badge).
 * The light sheet look is always white cells; dark themes use the panel colours of the app.
 */

const MAX_ROWS = 500;
const ROW_H = 26;
const NUM_W = 44;
const MIN_W = 64;
const MAX_COL_W = 240;
const CJK = /[ᄀ-ᇿ⺀-꓏가-힯豈-﫿︰-﹏＀-￯]/;

/** Display width in characters: CJK and full-width characters count 2. */
function textWidth(s: string): number {
  let n = 0;
  for (const ch of s) n += CJK.test(ch) ? 2 : 1;
  return n;
}

interface Palette { cell: string; head: string; line: string; ink: string; sub: string }

function SheetGrid({ rows, header, grid, pal, danger, fxLabel }: {
  rows: string[][]; header: boolean; grid: GridCell[][]; pal: Palette; danger: string; fxLabel: string;
}) {
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const shown = Math.min(rows.length, MAX_ROWS);
  const widths = useMemo(() => {
    const out: number[] = [];
    for (let c = 0; c < cols; c++) {
      let m = textWidth(colLetter(c));
      for (let r = 0; r < shown; r++) m = Math.max(m, textWidth(grid[r]?.[c]?.display ?? ''));
      out.push(Math.min(MAX_COL_W, Math.max(MIN_W, m * 8 + 16)));
    }
    return out;
  }, [grid, cols, shown]);

  const cellStyle = (w: number, bg: string) => [styles.cell, { width: w, height: ROW_H, backgroundColor: bg, borderColor: pal.line }];

  return (
    <ScrollView style={styles.fill} contentContainerStyle={styles.vpad}>
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <View>
          <View style={{ flexDirection: 'row' }}>
            <View style={cellStyle(NUM_W, pal.head)} />
            {widths.map((w, c) => (
              <View key={c} style={cellStyle(w, pal.head)}>
                <Text style={[styles.colHead, { color: pal.sub }]}>{colLetter(c)}</Text>
              </View>
            ))}
          </View>
          {Array.from({ length: shown }, (_, r) => {
            const isHead = header && r === 0;
            const bg = isHead ? pal.head : pal.cell;
            return (
              <View key={r} style={{ flexDirection: 'row' }}>
                <View style={cellStyle(NUM_W, pal.head)}>
                  <Text style={[styles.rowNum, { color: pal.sub }]}>{r + 1}</Text>
                </View>
                {widths.map((w, c) => {
                  const g = grid[r]?.[c];
                  const display = g?.display ?? '';
                  const color = g?.error ? danger : pal.ink;
                  return (
                    <View key={c} style={cellStyle(w, bg)}>
                      <Text
                        numberOfLines={1}
                        style={[
                          styles.text,
                          { color },
                          isHead && styles.bold,
                          g?.fx && !g?.error && styles.italic,
                          g?.isNumber && styles.right,
                        ]}
                      >
                        {g?.fx ? <Text style={[styles.fx, { color: pal.sub }]}>{`${fxLabel} `}</Text> : null}
                        {display}
                      </Text>
                    </View>
                  );
                })}
              </View>
            );
          })}
        </View>
      </ScrollView>
    </ScrollView>
  );
}

export default function XlsxPreview({ content }: { content: string; title: string }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const sheets = useMemo(() => parseSheets(content), [content]);
  const [picked, setPicked] = useState(0);
  const idx = Math.min(picked, Math.max(0, sheets.length - 1));
  const sheet = sheets[idx];
  const grid = useMemo(() => (sheet ? computeGrid(sheet.rows) : []), [sheet]);
  const charts = useMemo(() => sheetCharts(content, sheets).get(idx) ?? [], [content, sheets, idx]);

  if (!sheet) {
    return (
      <View style={[styles.fill, styles.center, { backgroundColor: t.bg }]}>
        <Text style={{ color: t.sub, fontSize: 14 }}>{tr('art.sheetEmpty')}</Text>
      </View>
    );
  }

  const dark = th.dark;
  const pal: Palette = dark
    ? { cell: t.panel, head: t.panel2, line: t.border, ink: t.text, sub: t.sub }
    : { cell: '#ffffff', head: '#f3f4f6', line: '#d1d5db', ink: '#111827', sub: '#6b7280' };
  const truncated = sheet.rows.length > MAX_ROWS;

  return (
    <View style={[styles.fill, { backgroundColor: t.bg }]}>
      <ScrollView horizontal style={[styles.tabs, { borderBottomColor: t.border }]} showsHorizontalScrollIndicator={false}>
        {sheets.map((s, i) => {
          const sel = i === idx;
          return (
            <Pressable
              key={`${i}-${s.name}`}
              accessibilityRole="tab"
              accessibilityLabel={s.name}
              accessibilityState={{ selected: sel }}
              onPress={() => setPicked(i)}
              style={[styles.tab, { borderBottomColor: sel ? t.accentInk : 'transparent' }]}
            >
              <Text style={{ color: sel ? t.text : t.sub, fontWeight: sel ? '700' : '400', fontSize: 14 }} numberOfLines={1}>
                {s.name}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      {truncated ? <Text style={[styles.note, { color: t.sub }]}>{tr('art.sheetTruncated', { n: MAX_ROWS })}</Text> : null}
      {sheet.rows.length === 0 ? (
        <View style={[styles.fill, styles.center]}>
          <Text style={{ color: t.sub, fontSize: 14 }}>{tr('art.sheetEmpty')}</Text>
        </View>
      ) : (
        <SheetGrid
          rows={sheet.rows}
          header={sheet.header}
          grid={grid}
          pal={pal}
          danger={t.danger}
          fxLabel={tr('art.fx')}
        />
      )}
      {charts.length > 0 && (
        <ScrollView style={[styles.charts, { borderTopColor: t.border, backgroundColor: pal.cell }]} contentContainerStyle={styles.chartsBody}>
          {charts.map((c, i) => (
            <ChartBlock key={i} source={JSON.stringify(c)} t={t} fallback={null} />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center', padding: 16 },
  vpad: { paddingBottom: 16 },
  tabs: { flexGrow: 0, borderBottomWidth: 1 },
  charts: { flexGrow: 0, maxHeight: 260, borderTopWidth: 1 },
  chartsBody: { padding: 12, gap: 8 },
  tab: { paddingHorizontal: 14, paddingVertical: 9, borderBottomWidth: 2 },
  note: { fontSize: 12, paddingHorizontal: 12, paddingVertical: 6 },
  cell: { borderRightWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, justifyContent: 'center', paddingHorizontal: 6, overflow: 'hidden' },
  colHead: { fontSize: 12, textAlign: 'center' },
  rowNum: { fontSize: 12, textAlign: 'center' },
  text: { fontSize: 13 },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  right: { textAlign: 'right' },
  fx: { fontSize: 10, fontWeight: '700' },
});
