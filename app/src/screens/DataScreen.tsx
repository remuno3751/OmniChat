import React, { useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { apiHistory, deliverText } from '../apiHistory';
import { getState, applySync } from '../store';
import { api } from '../api';
import { useT } from '../i18n';
import type { ImportCounts } from '../historyTypes';
import { useTheme, useThemeDef } from '../theme';
import { Btn, Hint, ScreenHeader } from '../ui/kit';
import { toast } from '../ui/toast';
import ConfigFiles from '../components/ConfigFiles';

const MAX_BYTES = 50 * 1024 * 1024;

interface Picked { name: string; text: string; counts: { projects: number; presets: number; conversations: number; messages: number } }

/** Opens a native file dialog (web only) and resolves with the chosen file, or null when cancelled. */
function pickFileWeb(): Promise<File | null> {
  return new Promise((resolve) => {
    const doc: any = (globalThis as any).document;
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';
    input.onchange = () => { const f = input.files?.[0] || null; input.remove(); resolve(f); };
    input.oncancel = () => { input.remove(); resolve(null); };
    doc.body.appendChild(input);
    input.click();
  });
}

function validate(tr: (key: string, vars?: Record<string, string | number>) => string, name: string, size: number, text: string): { ok: true; picked: Picked } | { ok: false; error: string } {
  if (size > MAX_BYTES) return { ok: false, error: tr('data.tooLarge') };
  let j: any;
  try { j = JSON.parse(text); } catch { return { ok: false, error: tr('data.notJson') }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, error: tr('data.notExport') };
  if (j.version !== 1) return { ok: false, error: tr('data.badVersion', { v: String(j.version) }) };
  if (!Array.isArray(j.conversations)) return { ok: false, error: tr('data.noConversations') };
  const arr = (x: any) => (Array.isArray(x) ? x : []);
  const messages = j.conversations.reduce((n: number, c: any) => n + arr(c?.messages).length, 0);
  return { ok: true, picked: { name, text, counts: { projects: arr(j.projects).length, presets: arr(j.presets).length, conversations: j.conversations.length, messages } } };
}

export default function DataScreen({ onBack }: { onBack: () => void }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const web = Platform.OS === 'web';
  const [busy, setBusy] = useState<'export' | 'read' | 'import' | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ImportCounts | null>(null);

  const exportAll = async () => {
    setBusy('export');
    try {
      const text = await apiHistory.exportAll();
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      await deliverText(`omnichat-export-${stamp}.json`, text, 'application/json');
      toast(tr('data.exportReady'), 'ok');
    } catch (e: any) { toast(e?.message || tr('sheet.export.failed'), 'error'); }
    setBusy(null);
  };

  const pick = async () => {
    setError(''); setResult(null); setPicked(null);
    setBusy('read');
    try {
      const f = await pickFileWeb();
      if (!f) { setBusy(null); return; }
      if (f.size > MAX_BYTES) { setError(tr('data.tooLarge')); setBusy(null); return; }
      const v = validate(tr, f.name, f.size, await f.text());
      if (v.ok) setPicked(v.picked); else setError(v.error);
    } catch (e: any) { setError(e?.message || tr('data.readFailed')); }
    setBusy(null);
  };

  const doImport = async () => {
    if (!picked) return;
    setBusy('import'); setError('');
    try {
      const r = await apiHistory.importData(picked.text);
      setResult(r || {});
      setPicked(null);
      try { applySync(await api.sync(getState().lastSeq)); } catch {}
    } catch (e: any) { setError(e?.message || tr('data.importFailed')); }
    setBusy(null);
  };

  const resultRows = result ? Object.entries(result).filter(([, v]) => typeof v === 'number') as [string, number][] : [];

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <ScreenHeader title={tr('data.title')} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={[styles.h, { color: t.text }]}>{tr('sheet.export.action')}</Text>
        <Text style={{ color: t.sub, fontSize: 13, lineHeight: 19 }}>
          {tr('data.exportDesc')}
        </Text>
        <Btn primary label={busy === 'export' ? tr('cfg.preparing') : tr('data.exportAll')} disabled={busy !== null} onPress={exportAll} style={{ marginTop: 10 }} />
        {!web && <Hint>{tr('data.exportNativeHint')}</Hint>}

        <Text style={[styles.h, { color: t.text, marginTop: 28 }]}>{tr('common.import')}</Text>
        <View style={[styles.warn, { borderRadius: th.r(10) }, { borderColor: t.warn }]}>
          <Text style={{ color: t.text, fontSize: 13, lineHeight: 19 }}>
            {tr('data.importWarn')}
          </Text>
        </View>
        {web ? (
          <Btn label={busy === 'read' ? tr('cfg.reading') : tr('data.importFromFile')} disabled={busy !== null} onPress={pick} style={{ marginTop: 10 }} />
        ) : (
          <Text style={{ color: t.sub, marginTop: 10 }}>{tr('data.importNative')}</Text>
        )}
        {!!error && <Text style={{ color: t.danger, marginTop: 10 }}>{error}</Text>}
        {picked && (
          <View style={[styles.card, { borderRadius: th.r(12) }, { borderColor: t.border, backgroundColor: t.panel }]}>
            <Text numberOfLines={1} style={{ color: t.text, fontWeight: '600' }}>{picked.name}</Text>
            <Text style={{ color: t.sub, marginTop: 4 }}>
              {tr('data.validExport', { conversations: picked.counts.conversations, messages: picked.counts.messages, projects: picked.counts.projects, presets: picked.counts.presets })}
            </Text>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, alignItems: 'center' }}>
              <Btn primary label={tr('data.importNew')} disabled={busy !== null} onPress={doImport} />
              <Btn label={tr('common.cancel')} disabled={busy !== null} onPress={() => setPicked(null)} />
              {busy === 'import' && <ActivityIndicator color={t.accentInk} />}
            </View>
            {busy === 'import' && <Hint>{tr('data.importWait')}</Hint>}
          </View>
        )}
        {result && (
          <View style={[styles.card, { borderRadius: th.r(12) }, { borderColor: t.good, backgroundColor: t.panel }]}>
            <Text style={{ color: t.good, fontWeight: '700' }}>{tr('data.importDone')}</Text>
            {resultRows.length === 0 && <Text style={{ color: t.text, marginTop: 4 }}>{tr('data.done')}</Text>}
            {resultRows.map(([k, v]) => <Text key={k} style={{ color: t.text, marginTop: 2 }}>{k}: {v}</Text>)}
          </View>
        )}
        <ConfigFiles />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { padding: 16, width: '100%', maxWidth: 720, alignSelf: 'center', paddingBottom: 40 },
  h: { fontSize: 16, fontWeight: '700', marginBottom: 6 },
  warn: { borderWidth: 1, padding: 12 },
  card: { borderWidth: 1, padding: 12, marginTop: 12 },
});
