import React, { useState } from 'react';
import { Linking, Platform, Pressable, Text, View } from 'react-native';
import type { SearchSource } from '../protocol';
import { Theme, useTheme, useThemeDef } from '../theme';
import { t as tt, useT } from '../i18n';
import { Btn, Sheet } from '../ui/kit';
import { toast } from '../ui/toast';
import { Tag, useFaces } from '../ui/skin';

export function hostOf(url: string): string {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return url.replace(/^https?:\/\//, '').split('/')[0]; }
}
export function openUrl(url: string) {
  if (!/^https?:\/\//i.test(url)) { toast(tt('msg.sources.onlyHttp'), 'error'); return; }
  if (Platform.OS === 'web') {
    try { (globalThis as any).open?.(url, '_blank', 'noopener,noreferrer'); return; } catch {}
  }
  Linking.openURL(url).catch(() => toast(tt('msg.sources.openFailed'), 'error'));
}

/** Opens a source preview (title, host, snippet) with an "Open" button. */
export function SourceSheet({ source, onClose }: { source: SearchSource | null; onClose: () => void }) {
  const t = useTheme();
  const tr = useT();
  return (
    <Sheet visible={!!source} onClose={onClose} title={source ? tr('sheet.source.title', { n: source.index }) : ''} width={460}
      footer={source ? <><Btn primary label={tr('sheet.source.open')} onPress={() => { openUrl(source.url); onClose(); }} /><Btn label={tr('common.close')} onPress={onClose} /></> : undefined}>
      {!!source && (
        <View>
          <Text selectable style={{ color: t.text, fontSize: 15, fontWeight: '700' }}>{source.title || hostOf(source.url)}</Text>
          <Text selectable style={{ color: t.accentInk, fontSize: 12, marginTop: 2 }}>{source.url}</Text>
          {!!source.snippet && <Text selectable style={{ color: t.sub, fontSize: 13, lineHeight: 19, marginTop: 8 }}>{source.snippet}</Text>}
        </View>
      )}
    </Sheet>
  );
}

/** Numbered "Sources" list under an answer. */
export function SourcesList({ sources, highlight }: { sources: SearchSource[] | null | undefined; highlight?: number | null }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const faces = useFaces();
  const themed = th.def.id !== 'simple';
  if (!sources?.length) return null;
  const sorted = [...sources].sort((a, b) => a.index - b.index);
  return (
    <View style={[{ marginTop: 8, paddingTop: 6, borderTopWidth: 1, borderTopColor: t.border }, themed && { marginTop: 10, paddingTop: 8 }]}>
      {themed ? <Tag style={{ marginBottom: 6 }}>{tr('msg.sources.heading')}</Tag> : <Text style={{ color: t.sub, fontSize: 11, fontWeight: '700', marginBottom: 3 }}>{tr('msg.sources.heading')}</Text>}
      {sorted.map((s) => (
        <Pressable
          key={s.index}
          onPress={() => openUrl(s.url)}
          accessibilityRole="link"
          accessibilityLabel={tr('msg.sources.a11y', { n: s.index, title: s.title })}
          style={({ hovered }: any) => ({ flexDirection: 'row', gap: 6, paddingVertical: 3, borderRadius: th.r(6), backgroundColor: highlight === s.index || hovered ? t.border : 'transparent' })}
        >
          <Text style={[{ color: t.accentInk, fontSize: 12, fontWeight: '700', minWidth: 18 }, faces.num]}>[{s.index}]</Text>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={2} style={{ color: t.text, fontSize: 13 }}>{s.title || hostOf(s.url)}</Text>
            <Text numberOfLines={1} style={{ color: t.sub, fontSize: 11 }}>{hostOf(s.url)}</Text>
          </View>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * Splits plain text into strings and tappable [n] badges. Only markers with a matching source become badges.
 * Returns React nodes to be placed inside a <Text>.
 */
export function withCitations(text: string, sources: SearchSource[] | null | undefined, t: Theme, onCite: (s: SearchSource) => void, radius = 6, square = false): React.ReactNode[] {
  if (!sources?.length) return [text];
  const byIndex = new Map(sources.map((s) => [s.index, s]));
  const out: React.ReactNode[] = [];
  const re = /\[(\d{1,3})\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    const src = byIndex.get(parseInt(m[1], 10));
    if (!src) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <Text
        key={`c${k++}`}
        onPress={() => onCite(src)}
        accessibilityRole="link"
        accessibilityLabel={tt('msg.sources.a11y', { n: src.index, title: src.title })}
        style={{ color: t.accentInk, backgroundColor: t.userBubble, borderRadius: radius, fontWeight: '700', fontSize: 12, ...(Platform.OS === 'web' ? ({ cursor: 'pointer' } as any) : null) }}
      >
        {square ? `[${src.index}]` : ` ${src.index} `}
      </Text>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length ? out : [text];
}

export function useCitationSheet() {
  const [src, setSrc] = useState<SearchSource | null>(null);
  return { src, open: setSrc, close: () => setSrc(null) };
}
