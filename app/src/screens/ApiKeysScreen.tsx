import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiError, api, getServerUrl } from '../api';
import { useT } from '../i18n';
import type { ApiKeyCreated, ApiKeyInfo } from '../protocol';
import { useTheme, useThemeDef } from '../theme';
import { copyText } from '../ui/clipboard';
import { confirmDialog } from '../ui/confirm';
import { Btn, Field, Hint, Label, ScreenHeader, fmtAgo } from '../ui/kit';
import { toast } from '../ui/toast';

/** Developer mode: API keys for the OpenAI-compatible /v1 endpoint. */
export default function ApiKeysScreen({ onBack }: { onBack: () => void }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const [keys, setKeys] = useState<ApiKeyInfo[] | null>(null);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const endpoint = getServerUrl() + '/v1';

  const load = useCallback(async () => {
    try {
      setKeys((await api.apiKeys()).keys || []);
      setErr('');
    } catch (e: any) {
      setErr(e instanceof ApiError && e.status === 404 ? tr('apikeys.unsupported') : e.message || String(e));
      setKeys([]);
    }
  }, [tr]);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      setCreated(await api.createApiKey(name.trim()));
      setName('');
      load();
    } catch (e: any) { toast(e.message || tr('apikeys.createFailed'), 'error'); } finally { setBusy(false); }
  };
  const del = async (k: ApiKeyInfo) => {
    if (!(await confirmDialog(tr('apikeys.deleteTitle'), tr('apikeys.deleteMsg', { name: k.name, prefix: k.prefix }), tr('common.delete')))) return;
    try { await api.deleteApiKey(k.id); load(); } catch (e: any) { toast(e.message || tr('list.deleteFailed'), 'error'); }
  };
  const copy = async (s: string) => toast((await copyText(s)) ? tr('msg.copied') : tr('msg.copyFailed'), 'ok');
  const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <ScreenHeader title={tr('settings.apiKeys')} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <View style={[styles.card, { borderRadius: th.r(12) }, { borderColor: t.border, backgroundColor: t.panel, flexDirection: 'column', alignItems: 'stretch' }]}>
          <Text style={{ color: t.text, fontWeight: '600' }}>{tr('apikeys.endpointLabel')}</Text>
          <Text selectable style={{ color: t.text, fontFamily: mono, fontSize: 13, marginTop: 4 }}>{endpoint}</Text>
          <Hint>{tr('apikeys.endpointHint')}</Hint>
          <View style={{ marginTop: 8 }}><Btn small label={tr('apikeys.copyEndpoint')} onPress={() => copy(endpoint)} /></View>
        </View>
        {created && (
          <View style={[styles.card, { borderRadius: th.r(12) }, { borderColor: t.accent, backgroundColor: t.panel, flexDirection: 'column', alignItems: 'stretch' }]}>
            <Text style={{ color: t.text, fontWeight: '600' }}>{tr('apikeys.newKey', { name: created.name })}</Text>
            <Text selectable style={{ color: t.text, fontFamily: mono, fontSize: 13, marginTop: 6 }}>{created.key}</Text>
            <Hint danger>{tr('apikeys.copyNow')}</Hint>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <Btn small primary label={tr('apikeys.copyKey')} onPress={() => copy(created.key)} />
              <Btn small label={tr('apikeys.done')} onPress={() => setCreated(null)} />
            </View>
          </View>
        )}
        <Label>{tr('apikeys.createHeading')}</Label>
        <Field value={name} onChangeText={setName} placeholder={tr('apikeys.namePlaceholder')} onSubmit={create} />
        <Btn primary label={busy ? tr('apikeys.creating') : tr('apikeys.createBtn')} disabled={!name.trim() || busy} onPress={create} />
        {!!err && <Hint danger>{err}</Hint>}
        <Label>{tr('apikeys.keysHeading')}</Label>
        {keys === null && <ActivityIndicator color={t.accentInk} />}
        {keys?.length === 0 && !err && <Text style={{ color: t.sub }}>{tr('apikeys.none')}</Text>}
        {keys?.map((k) => (
          <View key={k.id} style={[styles.card, { borderRadius: th.r(12) }, { borderColor: t.border, backgroundColor: t.panel }]}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontWeight: '600' }}>{k.name}</Text>
              <Text style={{ color: t.sub, fontSize: 12, fontFamily: mono }}>{k.prefix}...</Text>
              <Text style={{ color: t.sub, fontSize: 12 }}>{k.lastUsedAt ? tr('apikeys.lastUsed', { ago: fmtAgo(k.lastUsedAt) }) : tr('apikeys.neverUsed')}</Text>
            </View>
            <Btn small danger label={tr('common.delete')} onPress={() => del(k)} />
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { padding: 16, gap: 8, width: '100%', maxWidth: 720, alignSelf: 'center' },
  card: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, padding: 12 },
});
