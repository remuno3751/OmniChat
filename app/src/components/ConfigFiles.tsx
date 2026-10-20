import React, { useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import { api } from '../api';
import { apiDev } from '../apiDev';
import type { ConfigImportResult } from '../apiDev';
import { deliverText } from '../apiHistory';
import { useDevAvail } from '../devState';
import { useT } from '../i18n';
import { applySync, getState } from '../store';
import { useTheme, useThemeDef } from '../theme';
import { Btn, Field, Hint, Label, Segmented, useDevMode } from '../ui/kit';
import { toast } from '../ui/toast';

const MAX_BYTES = 1024 * 1024;
type Fmt = 'json' | 'yaml';

/** Opens a native file dialog (web only) and resolves with the chosen file, or null when cancelled. */
function pickConfigFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const doc: any = (globalThis as any).document;
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = '.json,.yaml,.yml,application/json,text/yaml';
    input.style.display = 'none';
    input.onchange = () => { const f = input.files?.[0] || null; input.remove(); resolve(f); };
    input.oncancel = () => { input.remove(); resolve(null); };
    doc.body.appendChild(input);
    input.click();
  });
}

/** JSON or YAML from the file name, else from the first character (`{` / `[` = JSON). */
export function detectFormat(name: string, text: string): Fmt {
  if (/\.ya?ml$/i.test(name)) return 'yaml';
  if (/\.json$/i.test(name)) return 'json';
  const c = text.trimStart()[0];
  return c === '{' || c === '[' ? 'json' : 'yaml';
}

const countRows = (o: Record<string, number> | undefined) => Object.entries(o || {}).filter(([, v]) => typeof v === 'number');
const reason = (r: any) => (typeof r === 'string' ? r : r?.reason ? `${r.name ? r.name + ': ' : ''}${r.reason}` : JSON.stringify(r));

/** Data screen section (developer mode, server with /config): export the config as JSON or YAML, import it from text or a file. */
export default function ConfigFiles() {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const dev = useDevMode();
  const ok = useDevAvail('config');
  const web = Platform.OS === 'web';
  const [busy, setBusy] = useState<'export' | 'import' | 'read' | null>(null);
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [fmt, setFmt] = useState<Fmt>('json');
  const [result, setResult] = useState<ConfigImportResult | null>(null);
  const [err, setErr] = useState('');

  if (!dev || !ok) return null;

  const exportCfg = async (f: Fmt) => {
    setBusy('export'); setErr('');
    try {
      const body = await apiDev.exportConfig(f);
      await deliverText(`omnichat-config.${f === 'yaml' ? 'yaml' : 'json'}`, body, f === 'yaml' ? 'application/yaml' : 'application/json');
      toast(tr('cfg.exported'), 'ok');
    } catch (e: any) { setErr(e?.message || tr('cfg.exportFailed')); }
    setBusy(null);
  };

  const chooseFile = async () => {
    setBusy('read'); setErr(''); setResult(null);
    try {
      const f = await pickConfigFile();
      if (f) {
        if (f.size > MAX_BYTES) setErr(tr('cfg.tooBigFile'));
        else {
          const body = await f.text();
          setText(body); setFileName(f.name); setFmt(detectFormat(f.name, body));
        }
      }
    } catch (e: any) { setErr(e?.message || tr('cfg.readFailed')); }
    setBusy(null);
  };

  const importCfg = async () => {
    setErr(''); setResult(null);
    if (!text.trim()) { setErr(tr('cfg.needInput')); return; }
    if (new Blob([text]).size > MAX_BYTES) { setErr(tr('cfg.tooBig')); return; }
    setBusy('import');
    try {
      const r = await apiDev.importConfig({ format: fmt, content: text, mode: 'merge' });
      setResult(r || {});
      try { applySync(await api.sync(getState().lastSeq)); } catch {}
      toast(tr('cfg.imported'), 'ok');
    } catch (e: any) { setErr(e?.message || tr('cfg.importFailed')); }
    setBusy(null);
  };

  const created = countRows(result?.created);
  const updated = countRows(result?.updated);
  const skipped = result?.skipped || [];

  return (
    <View style={{ marginTop: 28 }}>
      <Text style={[styles.h, { color: t.text }]}>{tr('cfg.title')}</Text>
      <Text style={{ color: t.sub, fontSize: 13, lineHeight: 19 }}>
        {tr('cfg.desc')}
      </Text>
      <View style={styles.row}>
        <Btn label={busy === 'export' ? tr('cfg.preparing') : tr('cfg.exportJson')} disabled={busy !== null} onPress={() => exportCfg('json')} />
        <Btn label={tr('cfg.exportYaml')} disabled={busy !== null} onPress={() => exportCfg('yaml')} />
      </View>

      <Label>{tr('cfg.importTitle')}</Label>
      <Hint>{tr('cfg.importHint')}</Hint>
      {web && (
        <View style={styles.row}>
          <Btn label={busy === 'read' ? tr('cfg.reading') : tr('cfg.chooseFile')} disabled={busy !== null} onPress={chooseFile} />
          {!!fileName && <Text numberOfLines={1} style={{ color: t.sub, fontSize: 12, alignSelf: 'center', flexShrink: 1 }}>{fileName} ({fmt.toUpperCase()})</Text>}
        </View>
      )}
      <Field
        label={tr('cfg.paste')}
        value={text}
        onChangeText={(v) => { setText(v); setFileName(''); }}
        multiline
        minHeight={120}
        mono
        placeholder={'{ "version": 1, "settings": { ... }, "projects": [ ... ] }'}
      />
      <View style={styles.row}>
        <Segmented<Fmt> options={[{ value: 'json', label: 'JSON' }, { value: 'yaml', label: 'YAML' }]} value={fmt} onChange={setFmt} />
        <Btn primary label={busy === 'import' ? tr('cfg.importing') : tr('cfg.importTitle')} disabled={busy !== null || !text.trim()} onPress={importCfg} />
        {busy === 'import' && <ActivityIndicator color={t.accentInk} />}
      </View>
      {!!err && <Text style={{ color: t.danger, marginTop: 8 }}>{err}</Text>}
      {result && (
        <View style={[styles.card, { borderColor: t.good, backgroundColor: t.panel, borderRadius: th.r(12) }]}>
          <Text style={{ color: t.good, fontWeight: '700' }}>{tr('cfg.finished')}</Text>
          {created.length === 0 && updated.length === 0 && <Text style={{ color: t.text, marginTop: 4 }}>{tr('cfg.nothingChanged')}</Text>}
          {created.map(([k, v]) => <Text key={'c' + k} style={{ color: t.text, marginTop: 2 }}>{tr('cfg.createdRow', { name: k, n: v })}</Text>)}
          {updated.map(([k, v]) => <Text key={'u' + k} style={{ color: t.text, marginTop: 2 }}>{tr('cfg.updatedRow', { name: k, n: v })}</Text>)}
          <Text style={{ color: t.text, marginTop: 2 }}>{tr('cfg.skipped', { n: skipped.length })}</Text>
          {skipped.slice(0, 20).map((s, i) => <Text key={i} style={{ color: t.sub, fontSize: 12, marginTop: 2 }}>- {reason(s)}</Text>)}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  h: { fontSize: 16, fontWeight: '700', marginBottom: 6 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10, alignItems: 'center' },
  card: { borderWidth: 1, padding: 12, marginTop: 12 },
});
