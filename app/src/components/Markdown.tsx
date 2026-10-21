import React, { useMemo, useState } from 'react';
import { Image, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { parseArtifactInfo } from '../artifacts';
import type { SearchSource } from '../protocol';
import { useAppearance, useThemeDef, type Theme } from '../theme';
import { useT } from '../i18n';
import { copyText } from '../ui/clipboard';
import { toast } from '../ui/toast';
import ArtifactCard from './ArtifactCard';
import ChartBlock from './ChartBlock';
import { tokenize } from './highlight';
import { openUrl, withCitations } from './Sources';
import { useFaces } from '../ui/skin';
import { MARK_RE, renderParticles, stripMarks } from '../ui/streamText';
import Icon from './Icon';

/** Code blocks longer than this are shown uncolored (keeps long answers fast). */
const HIGHLIGHT_MAX_LINES = 600;
/** Scales a size designed for a 16px base to the device font size. */
const sc = (fs: number, base: number) => Math.round((base * fs) / 16);
/** Body line height for a given font size. */
const bodyLh = (fs: number, boost = 0) => Math.round(fs * (1.45 + boost));

/*
 * GitHub-flavoured Markdown for chat messages, written by hand (no parser dependency).
 * Supported: headings, paragraphs, bold/italic/strike, inline code, fenced code (language label + Copy),
 * block quotes, ordered / unordered / task lists (nested by indentation), tables (horizontal scroll),
 * horizontal rules, links (opened externally, http/https only), images by URL (external images load only on request).
 * Raw HTML is never interpreted: `<b>` is shown as text.
 * While streaming, an unclosed code fence is shown as plain text until its closing fence arrives.
 */

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

import { parseBlocks, parseInline, type Align, type Block, type Inline } from './markdownParse';
export { parseBlocks, parseInline };
export type { Block, Inline };


interface Ctx {
  t: Theme;
  tr: ReturnType<typeof useT>;
  sources?: SearchSource[] | null;
  onCite?: (s: SearchSource) => void;
  /** device body font size (base 16) */
  fs: number;
  /** while streaming, code blocks are not highlighted */
  streaming: boolean;
  /** theme radius mapper (useThemeDef().r) */
  r: (n: number) => number;
  /** theme flavour: null in Simple (the original look) */
  skin: null | { ef: boolean; dark: boolean; lh: number; faces: ReturnType<typeof useFaces> };
  /** particle streaming: set once a chunk marker was met; later leaves of this render are animated too */
  fx?: { open: boolean };
}

function renderInline(nodes: Inline[], ctx: Ctx, prefix = 'i'): React.ReactNode[] {
  const { t } = ctx;
  return nodes.map((n, idx) => {
    const key = `${prefix}${idx}`;
    if (typeof n === 'string') {
      if (ctx.fx) return <React.Fragment key={key}>{renderParticles(n, key, ctx.fx)}</React.Fragment>;
      return (
        <React.Fragment key={key}>
          {ctx.sources?.length && ctx.onCite ? withCitations(n, ctx.sources, t, ctx.onCite, ctx.r(6), !!ctx.skin?.ef) : n}
        </React.Fragment>
      );
    }
    switch (n.type) {
      case 'code':
        return <Text key={key} style={[s.inlineCode, { backgroundColor: t.panel, color: t.text, fontSize: sc(ctx.fs, 14), borderRadius: ctx.r(4) }]}>{ctx.fx ? stripMarks(n.text) : n.text}</Text>;
      case 'bold':
        return <Text key={key} style={{ fontWeight: '700' }}>{renderInline(n.children, ctx, key)}</Text>;
      case 'italic':
        return <Text key={key} style={{ fontStyle: 'italic' }}>{renderInline(n.children, ctx, key)}</Text>;
      case 'strike':
        return <Text key={key} style={{ textDecorationLine: 'line-through' }}>{renderInline(n.children, ctx, key)}</Text>;
      case 'link': {
        const kids = renderInline(n.children, ctx, key);
        if (!/^https?:\/\//i.test(n.url)) return <React.Fragment key={key}>{kids}</React.Fragment>;
        return (
          <Text key={key} accessibilityRole="link" onPress={() => openUrl(n.url)} style={{ color: t.accentInk, textDecorationLine: 'underline' }}>
            {kids}
          </Text>
        );
      }
      case 'image':
        return (
          <Text key={key} accessibilityRole="link" onPress={() => openUrl(n.url)} style={{ color: t.accentInk, textDecorationLine: 'underline' }}>
            {`[${n.alt || ctx.tr('md.image')}]`}
          </Text>
        );
    }
  });
}

function blocksView(blocks: Block[], ctx: Ctx): React.ReactNode[] {
  return blocks.map((b, i) => <React.Fragment key={i}>{renderBlock(b, ctx)}</React.Fragment>);
}

function renderBlock(b: Block, ctx: Ctx): React.ReactNode {
  const { t } = ctx;
  switch (b.k) {
    case 'p':
      return <Text selectable style={[s.p, { color: t.text, fontSize: ctx.fs, lineHeight: bodyLh(ctx.fs, ctx.skin?.lh) }]}>{renderInline(parseInline(b.text), ctx)}</Text>;
    case 'raw':
      return <Text selectable style={[s.p, { color: t.text, fontSize: ctx.fs, lineHeight: bodyLh(ctx.fs, ctx.skin?.lh) }]}>{b.text}</Text>;
    case 'h': {
      const size = sc(ctx.fs, [22, 19, 17, 16, 15, 15][b.level - 1] ?? 16);
      const head = (
        <Text selectable accessibilityRole="header" style={{ color: t.text, fontSize: size, lineHeight: Math.round(size * 1.35), fontWeight: '700', marginTop: 8, marginBottom: 2 }}>
          {renderInline(parseInline(b.text), ctx)}
        </Text>
      );
      if (!ctx.skin || b.level > 3) return head;
      // Frontier: a short accent block before the heading; Astral: a gold hairline under it
      return ctx.skin.ef ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <View style={{ width: 4, height: Math.round(size * 0.9), backgroundColor: ctx.skin.dark ? t.accent : t.accent2, marginTop: 6 }} />
          <View style={{ flex: 1 }}>{head}</View>
        </View>
      ) : (
        <View style={{ borderBottomWidth: 1, borderBottomColor: t.borderStrong + '80', paddingBottom: 2, marginBottom: 4, alignSelf: 'stretch' }}>{head}</View>
      );
    }
    case 'code':
      if (b.lang === 'artifact') {
        const art = parseArtifactInfo(b.info ?? '');
        if (art) return <ArtifactCard artifact={{ type: art.type, title: art.title, content: b.body }} t={t} />;
      }
      if (b.lang === 'chart') {
        return <ChartBlock source={b.body} t={t} fallback={<CodeBlock lang={b.lang} body={b.body} t={t} fs={ctx.fs} plain={ctx.streaming} />} />;
      }
      return <CodeBlock lang={b.lang} body={b.body} t={t} fs={ctx.fs} plain={ctx.streaming} />;
    case 'quote':
      return <View style={[s.quote, { borderLeftColor: t.accent }]}>{blocksView(b.children, ctx)}</View>;
    case 'list':
      return (
        <View style={{ marginVertical: 3 }}>
          {b.items.map((it, i) => (
            <View key={i} style={s.li}>
              <View style={s.marker}>
                {it.task !== null ? (
                  <View
                    style={[s.box, { borderColor: t.sub, backgroundColor: it.task ? t.accent : 'transparent' }, ctx.skin && { width: 15, height: 15, borderRadius: ctx.r(3), borderColor: it.task ? t.accent : t.borderStrong, alignItems: 'center', justifyContent: 'center', marginTop: Math.round((bodyLh(ctx.fs, ctx.skin.lh) - 15) / 2) }]}
                    accessibilityLabel={ctx.tr(it.task ? 'md.taskDone' : 'md.taskOpen')}
                  >
                    {ctx.skin && it.task && <Icon name="check" size={12} color={t.accentText} />}
                  </View>
                ) : b.ordered ? (
                  <Text style={[{ color: t.sub, fontSize: ctx.fs, lineHeight: bodyLh(ctx.fs, ctx.skin?.lh) }, ctx.skin?.faces.num]}>{ctx.skin?.ef ? `${String(b.start + i).padStart(2, '0')}` : `${b.start + i}.`}</Text>
                ) : (
                  <View style={[s.dot, { backgroundColor: t.sub }, ctx.skin && { marginTop: Math.round(bodyLh(ctx.fs, ctx.skin.lh) / 2) - 3 }, ctx.skin?.ef && { borderRadius: 0, width: 5, height: 5 }, ctx.skin && !ctx.skin.ef && { backgroundColor: t.borderStrong, transform: [{ rotate: '45deg' }], borderRadius: 1 }]} />
                )}
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>{blocksView(it.children, ctx)}</View>
            </View>
          ))}
        </View>
      );
    case 'table':
      return (
        <ScrollView horizontal showsHorizontalScrollIndicator style={{ marginVertical: 6 }}>
          <View style={[s.table, { borderColor: t.border, borderRadius: ctx.r(6) }]}>
            {[b.head, ...b.rows].map((row, ri) => (
              <View key={ri} style={[s.tr, ri > 0 && { borderTopWidth: 1, borderTopColor: t.border }, ri === 0 && { backgroundColor: t.panel }, ri === 0 && ctx.skin && { backgroundColor: t.panel2, borderBottomWidth: ctx.skin.ef ? 2 : 1, borderBottomColor: ctx.skin.ef ? t.borderStrong : t.borderStrong + '80' }]}>
                {row.map((cell, ci) => (
                  <View key={ci} style={[s.td, ci > 0 && { borderLeftWidth: 1, borderLeftColor: t.border }]}>
                    <Text selectable style={[{ color: t.text, fontSize: sc(ctx.fs, 14), lineHeight: sc(ctx.fs, 20), fontWeight: ri === 0 ? '700' : '400', textAlign: b.align[ci] ?? 'left' }, ri === 0 && ctx.skin?.faces.labelBold]}>
                      {renderInline(parseInline(cell), ctx)}
                    </Text>
                  </View>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
    case 'hr':
      return <View style={{ height: 1, backgroundColor: t.border, marginVertical: 10 }} />;
    case 'img':
      return <ImageBlock url={b.url} alt={b.alt} t={t} r={ctx.r} />;
  }
}

function CodeBlock({ lang, body, t, fs, plain }: { lang: string; body: string; t: Theme; fs: number; plain: boolean }) {
  const tr = useT();
  const th = useThemeDef();
  const faces = useFaces();
  const tokens = useMemo(
    () => (plain || body.split('\n').length > HIGHLIGHT_MAX_LINES ? null : tokenize(body, lang)),
    [body, lang, plain],
  );
  return (
    <View style={[s.code, { backgroundColor: t.code, borderRadius: th.r(8) }]}>
      <View style={s.codeHead}>
        <Text style={[{ color: t.codeText, opacity: 0.7, fontSize: 12 }, faces.label, th.def.fonts.labelCaps && { fontSize: 10 }]}>{lang || tr('md.plainText')}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={tr('md.copyCode')}
          hitSlop={6}
          onPress={async () => {
            const ok = await copyText(body);
            toast(ok ? tr('msg.copied') : tr('msg.copyFailed'), ok ? 'ok' : 'error');
          }}
          style={s.copyBtn}
        >
          <Text style={{ color: t.codeText, fontSize: 12, fontWeight: '600' }}>{tr('common.copy')}</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ padding: 10 }}>
        <Text selectable style={[s.codeText, { color: t.codeText, fontSize: sc(fs, 13), lineHeight: sc(fs, 19) }]}>
          {tokens
            ? tokens.map((tk, k) => (tk.kind === 'plain' ? tk.text : <Text key={k} style={{ color: t.hl[tk.kind] }}>{tk.text}</Text>))
            : body}
        </Text>
      </ScrollView>
    </View>
  );
}

/** Host name shown for an external image. The query string is never shown (it may carry conversation data). */
function imageHost(url: string): string {
  try { return new URL(url).hostname; } catch { return url.replace(/^https?:\/\//i, '').split(/[/?#]/)[0]; }
}

/**
 * External (http/https) images are not fetched until the user asks: fetching sends the URL, query included, to that host.
 * Loading is per message and per image, kept only in component state.
 */
function ImageBlock({ url, alt, t, r }: { url: string; alt: string; t: Theme; r: (n: number) => number }) {
  const tr = useT();
  const [failed, setFailed] = useState(false);
  const [loadRequested, setLoadRequested] = useState(false);
  const external = /^https?:\/\//i.test(url);
  if (external && !loadRequested) {
    return (
      <View style={[s.extImage, { backgroundColor: t.panel, borderColor: t.border, borderRadius: r(8) }]}>
        {alt ? <Text style={{ color: t.text, fontSize: 14 }}>{alt}</Text> : null}
        <Pressable
          accessibilityRole="button"
          onPress={() => setLoadRequested(true)}
          style={[s.extImageBtn, { borderColor: t.accent, borderRadius: r(6) }]}
        >
          <Text style={{ color: t.accentInk, fontSize: 14, fontWeight: '600' }}>{tr('md.extImage.load', { host: imageHost(url) })}</Text>
        </Pressable>
        <Text style={{ color: t.sub, fontSize: 12 }}>{tr('md.extImage.note')}</Text>
      </View>
    );
  }
  if (failed) {
    return (
      <Text accessibilityRole="link" onPress={() => openUrl(url)} style={{ color: t.accentInk, textDecorationLine: 'underline' }}>
        {alt || url}
      </Text>
    );
  }
  return (
    <Pressable onPress={() => openUrl(url)} accessibilityRole="link" accessibilityLabel={alt || tr('md.imageLabel')} style={{ marginVertical: 6 }}>
      <Image
        source={{ uri: url }}
        accessibilityLabel={alt}
        onError={() => setFailed(true)}
        resizeMode="contain"
        style={{ width: '100%', maxWidth: 360, height: 220, borderRadius: r(8), backgroundColor: t.panel }}
      />
    </Pressable>
  );
}

/** Particle markers (ui/streamText) must not reach code / raw text. */
function stripDeep(v: unknown): unknown {
  if (typeof v === 'string') return stripMarks(v);
  if (Array.isArray(v)) return v.map(stripDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripDeep(x)]));
  return v;
}

function stripCodeMarks(bs: Block[]): Block[] {
  return bs.map((b): Block => {
    if (b.k === 'code') return { ...b, body: stripMarks(b.body) };
    if (b.k === 'raw') return { ...b, text: stripMarks(b.text) };
    if (b.k === 'quote') return { ...b, children: stripCodeMarks(b.children) };
    if (b.k === 'list') return { ...b, items: b.items.map((it) => ({ ...it, children: stripCodeMarks(it.children) })) };
    return b;
  });
}

export default function Markdown({ text, t, sources, onCite, streaming = false }: {
  text: string; t: Theme; sources?: SearchSource[] | null; onCite?: (s: SearchSource) => void; streaming?: boolean;
}) {
  const { fontSize } = useAppearance();
  const th = useThemeDef();
  const tr = useT();
  const faces = useFaces();
  const { blocks, fx } = useMemo(() => {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const b = parseBlocks(lines, streaming);
    if (!MARK_RE.test(text)) return { blocks: b, fx: false };
    // A particle marker inside block/inline syntax (before "- ", inside "|---|", "**", a fence...) changes how the text
    // parses and makes the layout jump. Keep the markers only when the structure is identical without them.
    const plain = parseBlocks(stripMarks(text.replace(/\r\n?/g, '\n')).split('\n'), streaming);
    const same = JSON.stringify(stripDeep(b)) === JSON.stringify(plain);
    return same ? { blocks: stripCodeMarks(b), fx: true } : { blocks: plain, fx: false };
  }, [text, streaming]);
  const skin = th.def.id === 'simple' ? null : { ef: th.def.variants.tabs === 'tag', dark: th.dark, lh: th.def.fonts.lineHeightBoost, faces };
  return <View>{blocksView(blocks, { t, tr, sources, onCite, fs: fontSize, streaming, r: th.r, skin, fx: fx ? { open: false } : undefined })}</View>;
}

const s = StyleSheet.create({
  p: { fontSize: 16, lineHeight: 23, marginVertical: 2 },
  inlineCode: { fontFamily: MONO, fontSize: 14, paddingHorizontal: 4 },
  quote: { borderLeftWidth: 3, paddingLeft: 10, marginVertical: 4 },
  li: { flexDirection: 'row', gap: 4, marginVertical: 1 },
  marker: { minWidth: 24, alignItems: 'flex-start' },
  dot: { width: 6, height: 6, borderRadius: 3, marginTop: 9, marginLeft: 6 },
  box: { width: 13, height: 13, borderWidth: 1.5, borderRadius: 3, marginTop: 5, marginLeft: 2 },
  table: { borderWidth: 1, overflow: 'hidden' },
  tr: { flexDirection: 'row' },
  td: { minWidth: 80, maxWidth: 260, paddingHorizontal: 8, paddingVertical: 5 },
  code: { overflow: 'hidden', marginVertical: 6 },
  codeHead: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 10, paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.12)',
  },
  copyBtn: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)' },
  extImage: { borderWidth: 1, borderRadius: 8, padding: 10, gap: 6, marginVertical: 6, maxWidth: 360 },
  extImageBtn: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1 },
  codeText: { fontFamily: MONO, fontSize: 13, lineHeight: 19 },
});
