import React, { useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { assemblePreview } from '../codePreview';
import type { VirtualFs } from '../codePreview';
import { useT, resolveLanguage } from '../i18n';
import { useDevice } from '../deviceSettings';
import { useTheme } from '../theme';
import CodePreviewView from './CodePreviewView';
import CodeText, { langOfPath } from './CodeText';

/*
 * Side / full-screen panel that previews the HTML, CSS and JS a Code run wrote.
 * Everything comes from the virtual files rebuilt by useCodePreviewFs; nothing is read from the PC.
 */

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });
type Tab = 'preview' | 'source';

export default function CodePreviewPanel({ fs, entries, loading, source, pcReason, pcLoading, onRefresh, onClose }: {
  fs: VirtualFs;
  entries: string[];
  loading: boolean;
  source: 'pc' | 'records';
  pcReason: string | null;
  pcLoading: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const tr = useT();
  const language = useDevice((s) => s.language);
  const lang: 'ja' | 'en' = resolveLanguage(language).startsWith('en') ? 'en' : 'ja';
  const [entry, setEntry] = useState('');
  const [runScripts, setRunScripts] = useState(true);
  const [allowExternal, setAllowExternal] = useState(false);
  const [tab, setTab] = useState<Tab>('preview');
  const [warnOpen, setWarnOpen] = useState(false);

  const cur = entries.includes(entry) ? entry : (entries[0] ?? '');

  // Only recomputed when the inputs change, so the WebView / iframe is not rebuilt on every render.
  const asm = useMemo(
    () => assemblePreview(fs, { entry: cur, runScripts, allowExternal, lang }),
    [fs, cur, runScripts, allowExternal, lang],
  );
  const stale = asm.used.some((p) => fs.get(p)?.stale);

  return (
    <View style={[styles.root, { backgroundColor: t.bg, borderLeftColor: t.border }]}>
      <View style={[styles.head, { borderBottomColor: t.border }]}>
        <Text style={[styles.title, { color: t.text }]}>{tr('code.preview.title')}</Text>
        <Pressable onPress={onRefresh} disabled={loading || pcLoading} style={[styles.btn, { borderColor: t.border }]} accessibilityRole="button">
          <Text style={{ color: t.text, fontSize: 13 }}>{tr('code.preview.reload')}</Text>
        </Pressable>
        <Pressable onPress={onClose} style={[styles.btn, { borderColor: t.border }]} accessibilityRole="button">
          <Text style={{ color: t.text, fontSize: 13 }}>{tr('code.preview.close')}</Text>
        </Pressable>
      </View>

      <Text style={{ color: source === 'pc' ? t.accent : t.sub, fontSize: 12, paddingHorizontal: 12, paddingTop: 6 }}>
        {pcLoading ? tr('code.preview.src.loading') : source === 'pc' ? tr('code.preview.src.pc') : tr('code.preview.src.records')}
        {source === 'records' && pcReason ? ` (${tr(`code.preview.pcReason.${pcReason}`)})` : ''}
      </Text>

      {entries.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips} contentContainerStyle={{ gap: 6, paddingHorizontal: 12 }}>
          <Text style={{ color: t.sub, fontSize: 12, alignSelf: 'center' }}>{tr('code.preview.entry')}</Text>
          {entries.map((p) => (
            <Pressable
              key={p}
              onPress={() => setEntry(p)}
              style={[styles.chip, { borderColor: t.border, backgroundColor: p === cur ? t.accent : 'transparent' }]}
            >
              <Text numberOfLines={1} style={{ color: p === cur ? t.accentInk : t.text, fontSize: 12, fontFamily: MONO }}>{p}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      <View style={styles.opts}>
        <View style={styles.optRow}>
          <Text style={[styles.optLabel, { color: t.text }]}>{tr('code.preview.runScripts')}</Text>
          <Switch value={runScripts} onValueChange={setRunScripts} />
        </View>
        <View style={styles.optRow}>
          <Text style={[styles.optLabel, { color: t.text }]}>{tr('code.preview.allowExternal')}</Text>
          <Switch value={allowExternal} onValueChange={setAllowExternal} />
        </View>
        {allowExternal && <Text style={{ color: t.warn, fontSize: 12 }}>{tr('code.preview.externalNote')}</Text>}
      </View>

      <View style={[styles.tabs, { borderBottomColor: t.border }]}>
        {(['preview', 'source'] as Tab[]).map((k) => (
          <Pressable key={k} onPress={() => setTab(k)} style={[styles.tab, tab === k && { borderBottomColor: t.accent, borderBottomWidth: 2 }]}>
            <Text style={{ color: tab === k ? t.text : t.sub, fontSize: 13 }}>
              {tr(k === 'preview' ? 'code.preview.tabPreview' : 'code.preview.tabSource')}
            </Text>
          </Pressable>
        ))}
      </View>

      {(asm.warnings.length > 0 || stale) && (
        <View style={styles.warnBox}>
          {stale && <Text style={{ color: t.warn, fontSize: 12 }}>{tr('code.preview.staleNote')}</Text>}
          {asm.warnings.length > 0 && (
            <Pressable onPress={() => setWarnOpen((o) => !o)}>
              <Text style={{ color: t.warn, fontSize: 12 }}>{tr('code.preview.warnings', { n: String(asm.warnings.length) })}</Text>
            </Pressable>
          )}
          {warnOpen && asm.warnings.map((w, i) => (
            <Text key={i} style={{ color: t.sub, fontSize: 12 }}>{w}</Text>
          ))}
        </View>
      )}

      {tab === 'preview' ? (
        <View style={styles.body}>
          {cur ? <CodePreviewView html={asm.html} runScripts={runScripts} allowExternal={allowExternal} /> : <Text style={{ color: t.sub, padding: 16 }}>{tr('code.preview.noEntry')}</Text>}
        </View>
      ) : (
        <ScrollView style={styles.body} contentContainerStyle={{ padding: 12, gap: 12 }}>
          {asm.used.length === 0 && <Text style={{ color: t.sub }}>{tr('code.preview.sourceEmpty')}</Text>}
          {asm.used.map((p) => (
            <View key={p}>
              <Text style={{ color: t.accent, fontFamily: MONO, fontSize: 12 }}>{p}</Text>
              <CodeText body={fs.get(p)?.content ?? ''} lang={langOfPath(p)} t={t} />
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, borderLeftWidth: StyleSheet.hairlineWidth },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { flex: 1, fontSize: 16, fontWeight: '600' },
  btn: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  chips: { maxHeight: 44, paddingVertical: 6 },
  chip: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, maxWidth: 200 },
  opts: { paddingHorizontal: 12, paddingVertical: 6, gap: 4 },
  optRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  optLabel: { flex: 1, fontSize: 13 },
  tabs: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  tab: { paddingHorizontal: 14, paddingVertical: 10 },
  warnBox: { paddingHorizontal: 12, paddingVertical: 6, gap: 4 },
  body: { flex: 1 },
});
