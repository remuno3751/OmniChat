import React, { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useT } from '../i18n';
import { useTheme } from '../theme';
import { Btn, Hint, Label } from '../ui/kit';
import { confirmDialog } from '../ui/confirm';
import { toast } from '../ui/toast';
import { Section } from '../screens/settings/common';
import {
  isBuiltinVoice, isCurrentStyle, kindForTtsMode, modelKind, modelVoiceId, parseServerVoices, type ServerVoiceModel,
} from '../voice/ariaVoices';
import { deleteVoiceModel, listVoices, type TtsMode } from '../voice/voiceApi';
import VoiceModelUpload from './VoiceModelUpload';
import VoicePreview from './VoicePreview';
import { ctx, errText } from './voiceUi';

/**
 * Settings > Voice call: the voice models of the current mode (standard = aivmx styles, fast = piper voices), the one in
 * use, a listen button, upload and delete of one's own models. Built-in models cannot be deleted.
 */
export default function VoiceServerVoicesCard({ ttsMode, current, onChoose }: {
  ttsMode: TtsMode; current: string; onChoose: (id: string) => void;
}) {
  const tr = useT();
  const th = useTheme();
  const kind = kindForTtsMode(ttsMode);
  const [models, setModels] = useState<ServerVoiceModel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [added, setAdded] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      setModels(parseServerVoices(await listVoices(ctx())));
    } catch (e) { setErr(errText(tr, e)); setModels(null); }
    setLoading(false);
  }, [tr]);
  useEffect(() => { void load(); }, [load]);

  const shown = (models ?? []).filter((m) => modelKind(m) === kind);
  const addedModel = added ? shown.find((m) => m.name === added || m.uuid === added) : undefined;

  const remove = async (m: ServerVoiceModel) => {
    if (isBuiltinVoice(m)) return;
    if (!m.uuid) { toast(tr('voice.voices.noId'), 'error'); return; }
    if (!(await confirmDialog(tr('voice.voices.deleteTitle', { name: m.name }), tr('voice.voices.deleteMsg'), tr('voice.voices.delete')))) return;
    try {
      await deleteVoiceModel(ctx(), m.uuid);
      toast(tr('voice.voices.deleted', { name: m.name }), 'info');
      await load();
    } catch (e) { toast(tr('voice.voices.err.delete', { msg: errText(tr, e) }), 'error'); }
  };

  return (
    <View style={{ gap: 6 }}>
      <Section title={tr(kind === 'piper' ? 'host.set.piperTitle' : 'voice.voices.title')} />
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Btn small label={tr('voice.voices.reload')} disabled={loading} onPress={() => void load()} />
        <Btn small label={tr('voice.voices.useDefault')} disabled={!current} onPress={() => onChoose('')} />
      </View>
      <Hint>{current ? tr('voice.voices.using', { id: current }) : tr('voice.voices.usingDefault')}</Hint>
      <VoicePreview ttsMode={ttsMode} voice={current} />
      {loading && <Hint>{tr('voice.voices.loading')}</Hint>}
      {!!err && <Hint danger>{err}</Hint>}
      {models && shown.length === 0 && !loading && <Hint>{tr('voice.voices.empty')}</Hint>}
      {shown.map((m, i) => {
        const builtin = isBuiltinVoice(m);
        const value = modelVoiceId(m, kind);
        return (
          <View key={`${m.uuid}-${i}`} style={{ borderWidth: 1, borderColor: th.border, borderRadius: 10, padding: 10, gap: 4, marginTop: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Text style={{ color: th.text, fontSize: 15, fontWeight: '600' }}>{m.name}</Text>
              {m.mine && <Label>{tr('host.set.mine')}</Label>}
            </View>
            <Text style={{ color: th.sub, fontSize: 12, lineHeight: 17 }}>{m.license ? tr('voice.voices.license', { text: m.license }) : tr('voice.voices.licenseNone')}</Text>
            {kind === 'piper' ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                <Btn small primary={isCurrentStyle(current, value)} label={tr('host.set.use')} onPress={() => onChoose(value)} />
              </View>
            ) : m.speakers.map((sp, j) => (
              <View key={j} style={{ gap: 4 }}>
                {!!sp.name && <Label>{sp.name}</Label>}
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {sp.styles.map((st) => {
                    const cur = isCurrentStyle(current, st.id);
                    return <Btn key={st.id} small primary={cur} label={cur ? `✓ ${st.name}` : st.name} onPress={() => onChoose(st.id)} />;
                  })}
                </View>
              </View>
            ))}
            {builtin ? (
              <Hint>{tr('host.set.builtin')}</Hint>
            ) : m.mine ? (
              <View style={{ flexDirection: 'row', marginTop: 4 }}><Btn small danger label={tr('voice.voices.delete')} onPress={() => void remove(m)} /></View>
            ) : null}
          </View>
        );
      })}
      {kind === 'aivmx' && <Hint>{tr('voice.voices.tsukuyomi')}</Hint>}
      {addedModel && (
        <View style={{ gap: 4, marginTop: 6 }}>
          <Label>{addedModel.name}</Label>
          <VoicePreview ttsMode={ttsMode} voice={modelVoiceId(addedModel, kind)} />
        </View>
      )}
      <VoiceModelUpload kind={kind} onUploaded={(name) => { setAdded(name); void load(); }} />
    </View>
  );
}
