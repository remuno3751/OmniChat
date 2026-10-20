import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, Text, View } from 'react-native';
import { ApiError, api } from '../api';
import type { DebugInfo, Metrics } from '../protocol';
import { getDevice } from '../deviceSettings';
import { resolveLanguage, t as tt, useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';
import { copyText } from '../ui/clipboard';
import { Btn, Hint, Segmented, Sheet } from '../ui/kit';
import { toast } from '../ui/toast';
import LogprobsView from './LogprobsView';

const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });
export type DebugTab = 'final' | 'raw' | 'metrics' | 'logprobs';
type Tab = DebugTab;
const j = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

/** Developer-mode viewer for GET /messages/:id/debug: final prompt and raw JSON. */
export default function DebugSheet({ messageId, tab: initialTab, metrics, onClose }: { messageId: string | null; tab: Tab; metrics?: Metrics | null; onClose: () => void }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [info, setInfo] = useState<DebugInfo | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!messageId) return;
    setTab(initialTab); setInfo(null); setErr(''); setBusy(true);
    let alive = true;
    api.messageDebug(messageId)
      .then((r) => { if (alive) setInfo(r); })
      .catch((e) => { if (alive) setErr(e instanceof ApiError && e.status === 404 ? tt('sheet.debug.none') : e.message || String(e)); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [messageId, initialTab]);

  const raw = info ? j(info) : '';
  const finalText = info ? info.final.messages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n') : '';
  const copy = async (text: string) => toast((await copyText(text)) ? tr('msg.copied') : tr('msg.copyFailed'), 'ok');
  const locale = resolveLanguage(getDevice().language);

  return (
    <Sheet visible={!!messageId} onClose={onClose} title={tr('sheet.debug.title')} width={720}>
      <Segmented<Tab> options={[
        { value: 'final', label: tr('sheet.debug.tabFinal') }, { value: 'raw', label: tr('sheet.debug.tabRaw') },
        ...(metrics ? [{ value: 'metrics' as Tab, label: tr('sheet.debug.tabSpeed') }] : []),
        ...(info?.response?.logprobs ? [{ value: 'logprobs' as Tab, label: 'Logprobs' }] : []),
      ]} value={tab} onChange={setTab} />
      {busy && <ActivityIndicator color={t.accentInk} style={{ margin: 20 }} />}
      {!!err && tab !== 'metrics' && <Hint danger>{err}</Hint>}
      {info && tab === 'logprobs' && <LogprobsView raw={info.response?.logprobs} />}
      {tab === 'metrics' && metrics && (
        <View style={{ marginTop: 10 }}>
          {Object.entries(metrics).filter(([, v]) => v != null).map(([k, v]) => (
            <View key={k} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 3, borderBottomWidth: 1, borderColor: t.border }}>
              <Text style={{ color: t.sub, fontSize: 13 }}>{k}</Text>
              <Text selectable style={{ color: t.text, fontSize: 13, fontFamily: mono, flexShrink: 1, textAlign: 'right' }}>{k === 'createdAt' && typeof v === 'number' ? new Date(v).toLocaleString(locale) : String(v)}</Text>
            </View>
          ))}
          {!!info?.response?.timings && <Hint>{tr('sheet.debug.timings', { v: j(info.response.timings) })}</Hint>}
          {!!info?.final?.contextAction && <Hint>{tr('sheet.debug.ctxAction', { v: j(info.final.contextAction) })}</Hint>}
          <View style={{ marginTop: 10 }}><Btn label={tr('sheet.debug.copyMetrics')} onPress={() => copy(j(metrics))} /></View>
        </View>
      )}
      {info && tab === 'final' && (
        <View style={{ marginTop: 10 }}>
          <Text style={{ color: t.text, fontSize: 13 }}>
            {info.model} · {info.providerKind} · {info.response?.status}{info.response?.finishReason ? ` (${info.response.finishReason})` : ''}
          </Text>
          <Hint>
            {info.final.effort?.sentAs
              ? tr('sheet.debug.effortSent', { req: String(info.final.effort?.requested ?? '-'), res: String(info.final.effort?.resolved ?? '-'), v: j(info.final.effort.sentAs) })
              : tr('sheet.debug.effort', { req: String(info.final.effort?.requested ?? '-'), res: String(info.final.effort?.resolved ?? '-') })}
          </Hint>
          {info.final.params ? <Hint>{tr('sheet.debug.params', { v: j(info.final.params) })}</Hint> : null}
          {info.response?.usage ? <Hint>{tr('sheet.debug.usage', { v: j(info.response.usage) })}</Hint> : null}
          {info.final.messages.map((m, i) => (
            <View key={i} style={{ marginTop: 8, borderWidth: 1, borderColor: t.border, borderRadius: th.r(8), overflow: 'hidden' }}>
              <Text style={{ backgroundColor: t.border, color: t.sub, fontSize: 11, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 3 }}>{m.role.toUpperCase()}</Text>
              <Text selectable style={{ color: t.text, fontSize: 13, padding: 8, fontFamily: mono }}>{m.content}</Text>
            </View>
          ))}
          <View style={{ marginTop: 10 }}><Btn label={tr('sheet.debug.copyPrompt')} onPress={() => copy(finalText)} /></View>
        </View>
      )}
      {info && tab === 'raw' && (
        <View style={{ marginTop: 10 }}>
          <ScrollView horizontal style={{ backgroundColor: t.code, borderRadius: th.r(8) }} contentContainerStyle={{ padding: 10 }}>
            <Text selectable style={{ color: t.codeText, fontFamily: mono, fontSize: 12 }}>{raw}</Text>
          </ScrollView>
          <View style={{ marginTop: 10 }}><Btn label={tr('msg.copyJson')} onPress={() => copy(raw)} /></View>
        </View>
      )}
    </Sheet>
  );
}
