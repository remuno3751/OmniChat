import React, { useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { useT } from '../i18n';
import { Btn, Hint } from '../ui/kit';
import { isNotSupportedYet, previewVoice, type TtsMode } from '../voice/voiceApi';
import { ctx, errText } from './voiceUi';

/**
 * "Listen" for a voice: a short sample from POST /voice/preview (WAV), played in the browser. The app has no audio
 * player on native (no expo-av / expo-audio in the package), so native shows a hint instead.
 */
export default function VoicePreview({ ttsMode, voice }: { ttsMode: TtsMode; voice: string }) {
  const tr = useT();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const playing = useRef<{ url: string; el: HTMLAudioElement } | null>(null);

  /** Stops the sample and frees its object URL. */
  const stop = () => {
    const p = playing.current;
    playing.current = null;
    if (!p) return;
    try { p.el.pause(); } catch { /* not playing */ }
    try { URL.revokeObjectURL(p.url); } catch { /* already gone */ }
  };
  useEffect(() => stop, []);

  if (Platform.OS !== 'web') return <Hint>{tr('host.set.previewNative')}</Hint>;

  const listen = async () => {
    setBusy(true);
    setErr('');
    try {
      const wav = await previewVoice(ctx(), { voice: voice || undefined, ttsMode });
      stop();
      const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
      const el = new Audio(url);
      playing.current = { url, el };
      el.onended = () => stop();
      await el.play();
    } catch (e) {
      stop();
      setErr(isNotSupportedYet(e) ? tr('host.set.previewNotSupported') : errText(tr, e));
    }
    setBusy(false);
  };

  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row' }}><Btn small label={tr('host.set.listen')} disabled={busy} onPress={() => void listen()} /></View>
      {!!err && <Hint danger>{err}</Hint>}
    </View>
  );
}
