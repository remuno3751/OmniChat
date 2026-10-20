import React, { useMemo, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View, type TextStyle } from 'react-native';
import { inlineRuns, parseMarkdown, toSlides, type Block, type Run, type Slide } from '../../docModel';
import { useT } from '../../i18n';
import { useTheme, useThemeDef } from '../../theme';
import type { Theme } from '../../theme';
import { TITLE_REGION, bodyRegion } from '../../shapeGeometry';
import SlideShapes from './SlideShapes';
import { useSlidePreview } from './useSlidePreview';

/*
 * Preview of a pptx artifact. The slides are split exactly like the server converter (toSlides), and each one is
 * drawn as a 16:9 card. Real slides are white whatever the app theme is, so the cards are too. Font sizes scale
 * with the card width, so the preview reads like the exported deck at any width.
 * A slide with a ```shapes block is drawn from the server's preview (the checked spec); see SlideShapes.
 */

const MAX_W = 640;
const GUTTER = 16;
const SLIDE_BG = '#ffffff';
const SLIDE_INK = '#1f2937';
const RULE = '#9ca3af';
const HEAD_FILL = '#e5e7eb';
const CODE_FILL = '#f3f4f6';
const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'Consolas, monospace' });

type Tr = ReturnType<typeof useT>;
/** A block that is text, a table or code (the blocks of the body), not a shapes block. */
type TextBlock = Exclude<Block, { kind: 'shapes' }>;

const bodyOf = (blocks: Block[]): TextBlock[] => blocks.filter((b): b is TextBlock => b.kind !== 'shapes');

/** Bold / italic / code runs of one line of text (inlineRuns, as the converter writes them). */
function RunText({ text, style }: { text: string; style: TextStyle }) {
  return (
    <Text style={style}>
      {inlineRuns(text).map((r: Run, i: number) => (
        <Text key={i} style={[r.bold && { fontWeight: '700' }, r.italics && { fontStyle: 'italic' }, r.code && { fontFamily: MONO }]}>{r.text}</Text>
      ))}
    </Text>
  );
}

/** Rough body capacity of a card at scale 1: lines of text and characters per line. */
const LINES_AVAIL = 8.5;
const CHARS_PER_LINE = 56;

/** Shrinks the body text when a slide holds more than fits (never below 60%). */
function bodyScale(blocks: TextBlock[], lines = LINES_AVAIL, charsPerLine = CHARS_PER_LINE): number {
  let need = 0;
  for (const b of blocks) {
    if (b.kind === 'code') need += Math.max(1, b.lines.length);
    else if (b.kind === 'table') need += b.rows.length * 0.9 + 0.5;
    else need += Math.max(1, Math.ceil(b.text.length / charsPerLine)) + 0.3;
  }
  return need > lines ? Math.max(0.6, lines / need) : 1;
}

/** Numbers for `ordered` items: they count up while consecutive, like PowerPoint auto-numbering. */
function ordinals(blocks: TextBlock[]): (number | null)[] {
  let n = 0;
  return blocks.map((b) => {
    if (b.kind !== 'ordered') { n = 0; return null; }
    n++;
    return n;
  });
}

function plainTitle(slide: Slide): string {
  return inlineRuns(slide.title).map((r) => r.text).join('') || ' ';
}

function TableView({ rows, fs, w }: { rows: string[][]; fs: number; w: number }) {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  return (
    <View style={{ borderWidth: 0.75, borderColor: RULE, marginBottom: fs * 0.6 }}>
      {rows.map((r, ri) => (
        <View key={ri} style={{ flexDirection: 'row', backgroundColor: ri === 0 ? HEAD_FILL : SLIDE_BG, borderTopWidth: ri === 0 ? 0 : 0.75, borderColor: RULE }}>
          {Array.from({ length: cols }, (_, ci) => (
            <View key={ci} style={{ flex: 1, paddingHorizontal: w * 0.012, paddingVertical: fs * 0.25, borderLeftWidth: ci === 0 ? 0 : 0.75, borderColor: RULE }}>
              <RunText text={r[ci] ?? ''} style={{ fontSize: fs * 0.85, lineHeight: fs * 1.2, color: SLIDE_INK, fontWeight: ri === 0 ? '700' : '400' }} />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

function SlideBody({ blocks, w, scale }: { blocks: TextBlock[]; w: number; scale: number }) {
  const fs = w * 0.028 * scale;
  const nums = ordinals(blocks);
  return (
    <View>
      {blocks.map((b, i) => {
        const gap = { marginBottom: fs * 0.45 };
        if (b.kind === 'table') return <TableView key={i} rows={b.rows} fs={fs} w={w} />;
        if (b.kind === 'code') {
          return (
            <View key={i} style={[{ backgroundColor: CODE_FILL, paddingHorizontal: w * 0.015, paddingVertical: fs * 0.2 }, gap]}>
              {b.lines.map((line, li) => (
                <Text key={li} style={{ fontFamily: MONO, fontSize: fs * 0.9, lineHeight: fs * 1.3, color: SLIDE_INK }}>{line || ' '}</Text>
              ))}
            </View>
          );
        }
        const indent = b.kind === 'bullet' ? w * 0.045 * b.level : 0;
        const marker = b.kind === 'bullet' ? '•' : b.kind === 'ordered' ? `${nums[i]}.` : null;
        return (
          <View key={i} style={[{ flexDirection: 'row', paddingLeft: indent }, gap]}>
            {marker ? <Text style={{ width: w * 0.05, fontSize: fs, lineHeight: fs * 1.4, color: SLIDE_INK }}>{marker}</Text> : null}
            <View style={{ flex: 1 }}>
              <RunText text={b.text} style={{ fontSize: fs, lineHeight: fs * 1.4, color: SLIDE_INK }} />
            </View>
          </View>
        );
      })}
    </View>
  );
}

function SlideCard({ slide, index, w, t, tr, r }: {
  slide: Slide; index: number; w: number; t: Theme; tr: Tr; r: (n: number) => number;
}) {
  const title = plainTitle(slide);
  const label = `${tr('art.slideN', { n: index + 1 })}: ${title.trim()}`;
  const shapes = slide.blocks.find((b): b is Extract<Block, { kind: 'shapes' }> => b.kind === 'shapes' && b.spec !== undefined);
  if (shapes?.spec) {
    // Shapes slide: the drawing covers the card; the title and the body go in their regions (shapeGeometry).
    const spec = shapes.spec;
    const h = (w * 9) / 16;
    const body = bodyOf(slide.blocks);
    const region = bodyRegion(spec.body);
    const scale = region ? bodyScale(body, ((region.h / 100) * h) / (w * 0.028 * 1.4), CHARS_PER_LINE * (region.w / 92)) : 1;
    return (
      <View style={styles.wrap}>
        <Text style={[styles.label, { color: t.sub }]}>{tr('art.slideN', { n: index + 1 })}</Text>
        <View accessible accessibilityLabel={label} style={[styles.card, { width: w, height: h, borderRadius: r(4) }]}>
          <SlideShapes spec={spec} w={w} />
          <View style={{ position: 'absolute', left: `${TITLE_REGION.x + 2}%`, top: `${TITLE_REGION.y}%`, width: `${TITLE_REGION.w - 4}%`, height: `${TITLE_REGION.h}%`, justifyContent: 'center' }}>
            <Text numberOfLines={1} style={{ fontSize: w * 0.045, lineHeight: w * 0.058, fontWeight: '700', color: SLIDE_INK }}>{title}</Text>
          </View>
          {region && body.length ? (
            <View style={{ position: 'absolute', left: `${region.x}%`, top: `${region.y}%`, width: `${region.w}%`, height: `${region.h}%`, overflow: 'hidden' }}>
              <SlideBody blocks={body} w={w} scale={scale} />
            </View>
          ) : null}
        </View>
      </View>
    );
  }
  const titleOnly = slide.blocks.length === 0;
  const body = bodyOf(slide.blocks);
  const scale = bodyScale(body);
  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, { color: t.sub }]}>{tr('art.slideN', { n: index + 1 })}</Text>
      <View
        accessible
        accessibilityLabel={label}
        style={[styles.card, { width: w, height: (w * 9) / 16, padding: w * 0.06, borderRadius: r(4) }]}
      >
        {titleOnly ? (
          <View style={styles.center}>
            <Text style={{ fontSize: w * 0.07, lineHeight: w * 0.09, fontWeight: '700', color: SLIDE_INK, textAlign: 'center' }}>{title}</Text>
          </View>
        ) : (
          <>
            <Text numberOfLines={2} style={{ fontSize: w * 0.045, lineHeight: w * 0.058, fontWeight: '700', color: SLIDE_INK, marginBottom: w * 0.03 }}>
              {title}
            </Text>
            <SlideBody blocks={body} w={w} scale={scale} />
          </>
        )}
      </View>
    </View>
  );
}

export default function PptxPreview({ content, title }: { content: string; title: string }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const [viewW, setViewW] = useState(0);
  const local = useMemo(() => toSlides(parseMarkdown(content), title), [content, title]);
  const remote = useSlidePreview(content, title, 'pptx');
  const slides = remote.slides ?? local;
  const w = Math.max(0, Math.min(viewW - GUTTER * 2, MAX_W));
  return (
    <ScrollView
      style={[styles.root, { backgroundColor: t.bg }]}
      contentContainerStyle={styles.content}
      onLayout={(e) => setViewW(e.nativeEvent.layout.width)}
    >
      <Text style={[styles.count, { color: t.sub }]}>{tr('art.slideCount', { n: slides.length })}</Text>
      {remote.oldServer ? <Text style={[styles.note, { color: t.sub }]}>{tr('slide.oldServer')}</Text> : null}
      {remote.failed ? <Text style={[styles.note, { color: t.sub }]}>{tr('slide.loadFailed')}</Text> : null}
      {w > 0 ? slides.map((s, i) => <SlideCard key={i} slide={s} index={i} w={w} t={t} tr={tr} r={th.r} />) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: GUTTER, paddingVertical: GUTTER, alignItems: 'center' },
  count: { alignSelf: 'flex-start', fontSize: 13, marginBottom: 12 },
  note: { alignSelf: 'flex-start', fontSize: 12, marginBottom: 12 },
  wrap: { marginBottom: 20, alignItems: 'flex-start' },
  label: { fontSize: 12, marginBottom: 6 },
  card: {
    backgroundColor: SLIDE_BG, borderWidth: 1, borderColor: '#d1d5db', overflow: 'hidden',
    shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3,
  },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
});
