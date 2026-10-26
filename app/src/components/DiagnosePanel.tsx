import React, { useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { getServerUrl, getToken } from '../api';
import { useT } from '../i18n';
import { useTheme } from '../theme';
import { Btn, Hint } from '../ui/kit';
import { Section } from '../screens/settings/common';
import { micErrorState, probeRelay, runDiagnose, type DiagRow, type MicState } from '../voice/diagnose';
import { buildRelayUrl, getDiagnose } from '../voice/voiceApi';
import { ctx } from './voiceUi';

/** The microphone check on the web: asks for the permission, then stops the stream at once. */
async function webMicCheck(): Promise<MicState> {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!md?.getUserMedia) return 'failed';
  try {
    const stream = await md.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return 'granted';
  } catch (e) {
    return micErrorState((e as { name?: string } | null)?.name);
  }
}

/**
 * "Diagnose": the server checks, the microphone and the relay connection, as a list. The relay probe opens the
 * connection with private=1 (no conversation or message is saved) and closes it after `ready`. The URL and the token
 * are never shown.
 */
export default function DiagnosePanel({ relayUrl }: { relayUrl?: string | null }) {
  const tr = useT();
  const th = useTheme();
  const [rows, setRows] = useState<DiagRow[] | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    if (running) return;
    setRunning(true);
    try {
      const url = relayUrl || buildRelayUrl(getServerUrl(), getToken() ?? null);
      const result = await runDiagnose({
        server: () => getDiagnose(ctx()),
        mic: Platform.OS === 'web' ? webMicCheck : async () => 'skipped',
        relayUrl: url,
        probe: (u) => probeRelay(u, {
          WebSocketImpl: WebSocket as any,
          now: () => Date.now(),
          schedule: (fn, ms) => setTimeout(fn, ms),
          cancel: (h) => clearTimeout(h as any),
        }),
      }, tr);
      setRows(result);
    } finally {
      setRunning(false);
    }
  };

  return (
    <View style={{ gap: 6 }}>
      <Section title={tr('host.diag.title')} />
      <Hint>{tr('host.diag.hint')}</Hint>
      <View style={{ flexDirection: 'row' }}>
        <Btn small label={running ? tr('host.diag.running') : tr('host.diag.run')} disabled={running} onPress={() => void run()} />
      </View>
      {(rows ?? []).map((r) => (
        <View key={r.id} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginTop: 4 }}>
          <Text style={{ color: r.level === 'ng' ? th.danger : th.text, fontSize: 15, width: 16 }}>
            {r.level === 'ok' ? '✓' : r.level === 'ng' ? '✕' : '–'}
          </Text>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: th.text, fontSize: 14, lineHeight: 20 }}>{r.message}</Text>
            {!!r.hint && <Hint>{r.hint}</Hint>}
          </View>
        </View>
      ))}
    </View>
  );
}
