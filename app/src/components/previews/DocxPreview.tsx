import React, { useMemo } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View, useWindowDimensions, type TextStyle } from 'react-native';
import { inlineRuns, parseMarkdown, type Block, type Run } from '../../docModel';
import { useT } from '../../i18n';
import { useTheme } from '../../theme';
import { attachSpecs, shapeTexts, specsInOrder } from '../../shapeGeometry';
import { useSlidePreview } from './useSlidePreview';
import ChartBlock, { parseChart } from '../ChartBlock';

/*
 * Preview of a docx artifact: a white "paper" page with the typography of the server converter (Word heading
 * styles, 14px body, Consolas code, bordered tables). Page breaks are estimated from line weights, since the
 * real pagination depends on the viewer; a dashed divider marks each estimated page.
 */

const PAGE_LINES = 46;
const INK = '#111111';
const MUTED = '#6b7280';
const RULE = '#9ca3af';
const TABLE_RULE = '#9ca3af';
const HEAD_FILL = '#f3f4f6';
const CODE_FILL = '#f3f4f6';
const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'Consolas, monospace' });
const HEAD_SIZE = [24, 19, 16, 14, 13, 13];

/** Bold / italic / code runs of one piece of text. */
function RunText({ text, style }: { text: string; style: TextStyle }) {
  return (
    <Text style={style}>
      {inlineRuns(text).map((r: Run, i: number) => (
        <Text key={i} style={[r.bold && { fontWeight: '700' }, r.italics && { fontStyle: 'italic' }, r.code && { fontFamily: MONO }]}>{r.text}</Text>
      ))}
    </Text>
  );
}

/** Estimated height of a block in text lines. */
function weight(b: Block): number {
  switch (b.kind) {
    case 'heading': return 2 + (b.level <= 2 ? 0.5 : 0);
    case 'para': return Math.ceil(b.text.length / 80) + 0.5;
    case 'bullet':
    case 'ordered': return Math.max(1, Math.ceil(b.text.length / 76));
    case 'code': return Math.max(1, b.lines.length);
    case 'table': return b.rows.length * 1.3;
    case 'shapes': return b.spec ? 1.5 + shapeTexts(b.spec).length : Math.max(1, b.raw.split('\n').length);
  }
}

/** Indexes of the blocks that start a new estimated page (the first page starts at 0 and is not listed). */
function pageStarts(blocks: Block[]): number[] {
  const starts: number[] = [];
  let acc = 0;
  blocks.forEach((b, i) => {
    const w = weight(b);
    if (acc > 0 && acc + w > PAGE_LINES) {
      starts.push(i);
      acc = 0;
    }
    acc += w;
  });
  return starts;
}

function PageDivider({ label }: { label: string }) {
  return (
    <View style={styles.divider}>
      <View style={styles.dashLine} />
      <Text style={styles.dividerText}>{label}</Text>
      <View style={styles.dashLine} />
    </View>
  );
}

function BlockView({ block }: { block: Block }) {
  const tr = useT();
  const theme = useTheme();
  switch (block.kind) {
    case 'shapes': {
      // Same alternative as the docx output: a "(figure)" line and the texts of the figure, as a list.
      if (!block.spec) {
        return (
          <View style={styles.code}>
            <Text style={styles.codeText}>{block.raw || ' '}</Text>
          </View>
        );
      }
      const texts = shapeTexts(block.spec);
      return (
        <View style={{ marginBottom: 8 }}>
          <Text style={[styles.para, { color: MUTED }]}>{tr('slide.figure')}</Text>
          {texts.map((s, i) => (
            <View key={i} style={[styles.item, { marginLeft: 18 }]}>
              <Text style={styles.marker}>{'•'}</Text>
              <View style={styles.itemBody}><RunText text={s} style={styles.para} /></View>
            </View>
          ))}
        </View>
      );
    }
    case 'heading': {
      const size = HEAD_SIZE[Math.min(block.level, 6) - 1];
      return <RunText text={block.text} style={{ fontSize: size, lineHeight: size * 1.3, fontWeight: '700', color: INK, marginTop: size * 0.7, marginBottom: size * 0.35 }} />;
    }
    case 'para':
      return <RunText text={block.text} style={styles.para} />;
    case 'bullet':
      return (
        <View style={[styles.item, { marginLeft: 18 + block.level * 18 }]}>
          <Text style={styles.marker}>{'•'}</Text>
          <View style={styles.itemBody}><RunText text={block.text} style={styles.para} /></View>
        </View>
      );
    case 'ordered':
      return (
        <View style={[styles.item, { marginLeft: 18 }]}>
          <Text style={styles.marker}>{`${block.n}.`}</Text>
          <View style={styles.itemBody}><RunText text={block.text} style={styles.para} /></View>
        </View>
      );
    case 'code': {
      const src = block.lines.join('\n');
      if (parseChart(src)) return <ChartBlock source={src} t={theme} fallback={null} />;
      return (
        <View style={styles.code}>
          <Text style={styles.codeText}>{block.lines.length ? src : ' '}</Text>
        </View>
      );
    }
    case 'table': {
      const cols = Math.max(1, ...block.rows.map((r) => r.length));
      return (
        <View style={styles.table}>
          {block.rows.map((r, ri) => (
            <View key={ri} style={[styles.tr, ri === 0 && { backgroundColor: HEAD_FILL }]}>
              {Array.from({ length: cols }, (_, ci) => (
                <View key={ci} style={[styles.td, ci > 0 && styles.tdLeft]}>
                  <RunText text={r[ci] ?? ''} style={{ fontSize: 13, lineHeight: 18, color: INK, fontWeight: ri === 0 ? '700' : '400' }} />
                </View>
              ))}
            </View>
          ))}
        </View>
      );
    }
  }
}

export default function DocxPreview({ content, title }: { content: string; title: string }) {
  const t = useTheme();
  const tr = useT();
  const { width } = useWindowDimensions();
  const remote = useSlidePreview(content, title, 'docx');
  const blocks = useMemo(() => attachSpecs(parseMarkdown(content), specsInOrder(remote.slides ?? [])), [content, remote.slides]);
  const starts = useMemo(() => pageStarts(blocks), [blocks]);
  const pages = starts.length + 1;
  const pad = width < 520 ? 20 : 48;
  return (
    <ScrollView style={[styles.root, { backgroundColor: t.bg }]} contentContainerStyle={styles.content} accessibilityLabel={title}>
      <View style={[styles.paper, { padding: pad }]}>
        {pages > 1 ? <Text style={styles.pageLabel}>{tr('art.docPage', { n: 1 })}</Text> : null}
        {blocks.map((b, i) => {
          const k = starts.indexOf(i);
          return (
            <React.Fragment key={i}>
              {k >= 0 ? <PageDivider label={tr('art.docPage', { n: k + 2 })} /> : null}
              <BlockView block={b} />
            </React.Fragment>
          );
        })}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16 },
  paper: {
    width: '100%', maxWidth: 680, alignSelf: 'center', backgroundColor: '#ffffff', minHeight: 300,
    shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 4,
  },
  pageLabel: { fontSize: 12, color: MUTED, textAlign: 'right', marginBottom: 8 },
  para: { fontSize: 14, lineHeight: 22, color: INK, marginBottom: 8 },
  item: { flexDirection: 'row', marginBottom: 4 },
  marker: { width: 18, fontSize: 14, lineHeight: 22, color: INK },
  itemBody: { flex: 1 },
  code: { backgroundColor: CODE_FILL, padding: 10, borderRadius: 4, marginBottom: 10 },
  codeText: { fontFamily: MONO, fontSize: 12, lineHeight: 17, color: INK },
  table: { borderWidth: 0.75, borderColor: TABLE_RULE, marginBottom: 12 },
  tr: { flexDirection: 'row', borderTopWidth: 0.75, borderColor: TABLE_RULE },
  td: { flex: 1, minWidth: 80, paddingHorizontal: 8, paddingVertical: 5 },
  tdLeft: { borderLeftWidth: 0.75, borderColor: TABLE_RULE },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 16 },
  dashLine: { flex: 1, height: 0, borderTopWidth: 1, borderStyle: 'dashed', borderColor: RULE },
  dividerText: { fontSize: 12, color: MUTED },
});
