// The bar at the top of a chat while an Aria voice call runs: status, mute or push-to-talk, interrupt, reconnect,
// settings, end. Settings are saved on the server (putMe) and sent to the live call (updateSettings, not persisted there).
import React, { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { getServerUrl, getToken } from '../api';
import { useTheme } from '../theme';
import { toast } from '../ui/toast';
import { Btn, Hint, Label, Segmented } from '../ui/kit';
import { useT } from '../i18n';
import type { VoiceCallError, VoiceCallHook } from '../voice/useVoiceCall';
import { effectiveSpeed, getStatus, putMe } from '../voice/voiceApi';
import type { TtsMode, VoiceUserPrefs } from '../voice/voiceApi';
import { closeReasonKey, isTypingTarget } from '../voice/callLogic';
import DiagnosePanel from './DiagnosePanel';

type Settings = Record<string, number | string | boolean>;

export default function VoiceCallBar({ call }: { call: VoiceCallHook }) {
  const t = useTheme();
  const tr = useT();
  const [panelOpen, setPanelOpen] = useState(false);
  // the user's saved prefs (explicit values only; speed unset = the default for the mode). PUT sends all of them.
  const [prefs, setPrefs] = useState<VoiceUserPrefs>({});
  const [holding, setHolding] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    getStatus({ base: getServerUrl(), token: getToken() })
      .then((st) => {
        const me = st.me;
        setPrefs({
          voice: me.voice, ttsMode: me.ttsMode, speed: me.speed, pauseScale: me.pauseScale,
          responseDelayMs: me.responseDelayMs, endOfTurnMs: me.endOfTurnMs, bargeIn: me.bargeIn, bargeInDb: me.bargeInDb,
        });
      })
      .catch(() => undefined);
  }, []);

  // the reconnect button counts down to call.retryAt; the ticks stop once it has passed
  useEffect(() => {
    const until = call.retryAt;
    if (until <= Date.now()) return undefined;
    const id = setInterval(() => {
      tick((n) => n + 1);
      if (Date.now() >= until) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, [call.retryAt]);
  const waitMs = Math.max(0, call.retryAt - Date.now());

  const ready = call.state === 'ready';
  const ppt = call.pushToTalk;
  const talk = call.talk;
  const modes = call.ttsModes;
  const modeOk = (m: string) => modes === null || modes.includes(m);
  const meter = Math.round(Math.min(1, Math.max(0, call.micLevel)) * 100);
  const terminal = call.closeReason === 'voice_off' || call.closeReason === 'busy' || call.closeReason === 'quota';
  const canReconnect = !terminal && (call.state === 'closed' || (call.state === 'error' && (call.error === 'unreachable' || call.error === 'failed')));

  // push-to-talk with the space key (web): held = mic on. Not while a text field has the focus; repeats are ignored.
  useEffect(() => {
    if (Platform.OS !== 'web' || !ppt || !ready || typeof document === 'undefined') return undefined;
    let down = false;
    const press = (on: boolean) => {
      down = on;
      setHolding(on);
      talk(on);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isTypingTarget(document.activeElement)) return;
      e.preventDefault();
      if (!e.repeat && !down) press(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !down) return;
      e.preventDefault();
      press(false);
    };
    const onBlur = () => {
      if (down) press(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      if (down) press(false);
    };
  }, [ppt, ready, talk]);

  const pressTalk = (on: boolean) => {
    setHolding(on);
    talk(on);
  };

  /** a changed value: remembered on the server, and applied to the live call right away (not persisted there) */
  const save = async (patch: VoiceUserPrefs, ariaValues: Settings) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    call.updateSettings(ariaValues, false);
    try {
      await putMe({ base: getServerUrl(), token: getToken() }, next);
    } catch {
      toast(tr('host.call.saveFailed'), 'error');
    }
  };

  const status = (): string => {
    if (call.state === 'error') return tr(ERROR_TEXT[call.error ?? 'failed']);
    if (call.state === 'ready') {
      if (call.listening) return tr('voice.call.listening');
      if (call.speaking) return tr('voice.call.speaking');
      if (call.muted) return tr('voice.call.muted');
      return tr('voice.call.live');
    }
    if (call.state === 'closed') return tr('voice.call.closed');
    return tr('voice.call.connecting');
  };

  return (
    <View style={[styles.root, { borderColor: t.border, backgroundColor: t.panel }]}>
      <View style={styles.row}>
        <Text style={{ color: t.text, fontSize: 13, fontWeight: '600', flexShrink: 1 }} numberOfLines={1}>
          {status()}
        </Text>
        {call.serverPrivate && (
          <Text style={[styles.badge, { color: t.accentInk, borderColor: t.accent }]}>{tr('host.call.privateBadge')}</Text>
        )}
        <View style={[styles.meter, { backgroundColor: t.border }]}>
          <View style={{ width: `${meter}%`, height: '100%', backgroundColor: t.accent }} />
        </View>
        {call.latencyMs !== null && (
          <Text style={{ color: t.sub, fontSize: 12 }}>{tr('host.call.latency', { ms: Math.round(call.latencyMs) })}</Text>
        )}
      </View>
      {call.serverPrivate && <Hint>{tr('host.call.privateNotice')}</Hint>}
      {call.state === 'ready' && call.error === 'mic-denied' && <Hint danger>{tr('voice.call.micDenied')}</Hint>}
      {(call.state === 'closed' || (call.state === 'error' && call.closeReason !== null)) && (
        <Hint>{tr(closeReasonKey(call.closeReason))}</Hint>
      )}
      {call.serverPrivate && call.lines.length > 0 && (
        <View style={styles.live}>
          <Text style={{ color: t.sub, fontSize: 11 }}>{tr('host.call.liveText')}</Text>
          {call.lines.slice(-3).map((l) => (
            <Text key={l.id} style={{ color: l.role === 'user' ? t.text : t.sub, fontSize: 13 }} numberOfLines={2}>
              {l.text}
            </Text>
          ))}
        </View>
      )}
      <View style={styles.row}>
        {ready && !ppt && <Btn small label={call.muted ? tr('voice.call.unmute') : tr('voice.call.mute')} onPress={call.toggleMute} />}
        {ready && ppt && (
          <Pressable
            onPressIn={() => pressTalk(true)}
            onPressOut={() => pressTalk(false)}
            accessibilityRole="button"
            accessibilityLabel={tr('host.call.pushToTalk')}
            accessibilityState={{ selected: holding }}
            style={[styles.talk, { borderColor: t.accent, backgroundColor: holding ? t.accent : 'transparent' }]}
          >
            <Text style={{ color: holding ? t.accentInk : t.text, fontSize: 13, fontWeight: '600' }}>{tr('host.call.pushToTalk')}</Text>
          </Pressable>
        )}
        {ready && <Btn small label={tr('voice.call.interrupt')} onPress={call.interrupt} />}
        {ready && <Btn small label={panelOpen ? tr('voice.call.settingsHide') : tr('voice.call.settings')} onPress={() => setPanelOpen((o) => !o)} />}
        {canReconnect && (
          <Btn
            small
            label={waitMs > 0 ? tr('host.call.retryIn', { s: Math.ceil(waitMs / 1000) }) : tr('voice.call.reconnect')}
            disabled={waitMs > 0}
            onPress={call.reconnect}
          />
        )}
        <View style={{ flex: 1 }} />
        <Btn small danger label={tr('voice.call.end')} onPress={call.stop} />
      </View>
      {panelOpen && ready && (
        <View style={styles.panel}>
          <Hint>{tr('voice.call.settingsHint')}</Hint>
          {ppt && <Hint>{tr('host.call.pushToTalkHint')}</Hint>}
          <Label>{tr('voice.set.ttsMode')}</Label>
          <Segmented<TtsMode>
            value={prefs.ttsMode ?? 'balanced'}
            onChange={(m) => save({ ttsMode: m }, { tts_mode: m })}
            options={(['balanced', 'fast'] as const).map((m) => ({ value: m, label: tr(`voice.set.ttsMode.${m}`), disabled: !modeOk(m) }))}
          />
          {!(modeOk('balanced') && modeOk('fast')) && <Hint>{tr('voice.call.modeUnavailable')}</Hint>}
          <Stepper
            label={tr('voice.set.speed')}
            value={effectiveSpeed(prefs)}
            min={0.5}
            max={2}
            step={0.1}
            format={(n) => n.toFixed(1)}
            onChange={(n) => save({ speed: n }, { speed: n })}
          />
          <DiagnosePanel relayUrl={call.relayUrl} />
        </View>
      )}
    </View>
  );
}

const ERROR_TEXT: Record<VoiceCallError, string> = {
  off: 'host.call.err.off',
  busy: 'host.call.err.busy',
  quota: 'host.call.err.quota',
  unreachable: 'host.call.err.unreachable',
  'mic-denied': 'voice.call.micDenied',
  unsupported: 'voice.call.unsupported',
  failed: 'host.call.err.failed',
};

/** A number with - and + buttons (the same idea as the old call screen's Stepper). */
function Stepper({ label, value, min, max, step, format, onChange }: {
  label: string; value: number; min: number; max: number; step: number; format: (n: number) => string; onChange: (n: number) => void;
}) {
  const t = useTheme();
  const fix = (n: number) => Math.round(n * 100) / 100;
  return (
    <View style={styles.row}>
      <Text style={{ color: t.sub, fontSize: 12, flex: 1, minWidth: 120 }}>{label}</Text>
      <Btn small label="-" disabled={value <= min} onPress={() => onChange(fix(Math.max(min, value - step)))} />
      <Text style={{ color: t.text, minWidth: 70, textAlign: 'center', fontSize: 14 }}>{format(value)}</Text>
      <Btn small label="+" disabled={value >= max} onPress={() => onChange(fix(Math.min(max, value + step)))} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { paddingHorizontal: 14, paddingVertical: 10, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  meter: { width: 64, height: 6, borderRadius: 3, overflow: 'hidden' },
  badge: { fontSize: 11, fontWeight: '600', borderWidth: 1, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  talk: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6 },
  live: { gap: 2 },
  panel: { gap: 8 },
});
