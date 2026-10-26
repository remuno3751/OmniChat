import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { setDevice, useDevice } from '../../deviceSettings';
import { useT } from '../../i18n';
import { useTheme } from '../../theme';
import { toast } from '../../ui/toast';
import { Btn, Check, Hint, Label, Segmented } from '../../ui/kit';
import DiagnosePanel from '../../components/DiagnosePanel';
import VoiceServerVoicesCard from '../../components/VoiceServerVoicesCard';
import { ctx } from '../../components/voiceUi';
import { AriaHttpError } from '../../voice/ariaRest';
import { callTimeParts } from '../../voice/ariaVoices';
import {
  effectiveSpeed, getStatus, getUsage, isAriaUnreachable, isVoiceOff, putMe,
  type TtsMode, type VoiceStatus, type VoiceUsage, type VoiceUserPrefs,
} from '../../voice/voiceApi';
import type { VoiceCodec } from '../../voice/voiceSettings';
import { PageFrame, Section } from './common';

const TTS_MODES: { value: TtsMode; label: string }[] = [
  { value: 'balanced', label: 'voice.set.ttsMode.balanced' },
  { value: 'fast', label: 'voice.set.ttsMode.fast' },
];

const CODECS: { value: VoiceCodec; label: string }[] = [
  { value: 'pcm16', label: 'voice.call.codec.pcm16' },
  { value: 'opus', label: 'voice.call.codec.opus' },
];

/** What is shown for the values the user has not set (the server's defaults). speed has its own default (effectiveSpeed). */
const SHOWN = { pauseScale: 1, responseDelayMs: 0, endOfTurnMs: 350, bargeIn: true, bargeInDb: -35 };

/** The user's own prefs from status.me, without the server's computed `effective` values. */
function ownPrefs(me: (VoiceUserPrefs & { effective?: VoiceUserPrefs }) | undefined): VoiceUserPrefs {
  const { effective: _effective, ...own } = me ?? {};
  return own;
}

/** A number with - and + buttons, clamped to [min, max] in steps of `step`. */
function Stepper({ label, value, min, max, step, format, disabled, onChange }: {
  label: string; value: number; min: number; max: number; step: number; format: (n: number) => string;
  disabled?: boolean; onChange: (n: number) => void;
}) {
  const t = useTheme();
  const fix = (n: number) => Math.round(n * 100) / 100;
  return (
    <>
      <Label>{label}</Label>
      <View style={styles.row}>
        <Btn small label="-" disabled={disabled || value <= min} onPress={() => onChange(fix(Math.max(min, value - step)))} />
        <Text style={{ color: t.text, minWidth: 90, textAlign: 'center', fontSize: 15 }}>{format(value)}</Text>
        <Btn small label="+" disabled={disabled || value >= max} onPress={() => onChange(fix(Math.min(max, value + step)))} />
      </View>
    </>
  );
}

type LoadError = 'off' | 'unreachable' | 'generic';

/** Settings > Voice call: the speaking style, this device's call switches, usage, the voice models and a diagnosis. */
export default function VoicePage({ onBack }: { onBack: () => void }) {
  const tr = useT();
  const voice = useDevice((s) => s.voice);
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [usage, setUsage] = useState<VoiceUsage | null>(null);
  const [loadErr, setLoadErr] = useState<LoadError | null>(null);
  const [loading, setLoading] = useState(false);
  const [prefs, setPrefsState] = useState<VoiceUserPrefs>({});
  // the latest prefs: save() reads these, so two quick changes do not lose one another
  const latest = useRef<VoiceUserPrefs>({});
  const seq = useRef(0);
  const applyPrefs = useCallback((p: VoiceUserPrefs) => {
    latest.current = p;
    setPrefsState(p);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadErr(null);
    try {
      const s = await getStatus(ctx());
      setStatus(s);
      applyPrefs(ownPrefs(s.me));
      // the usage is optional: when it fails, its part is simply left out
      getUsage(ctx()).then(setUsage, () => setUsage(null));
    } catch (e) {
      setStatus(null);
      setUsage(null);
      setLoadErr(isVoiceOff(e) ? 'off' : isAriaUnreachable(e) || (e instanceof AriaHttpError && e.status === 0) ? 'unreachable' : 'generic');
    }
    setLoading(false);
  }, [applyPrefs]);
  useEffect(() => { void load(); }, [load]);

  /** Apply the change at once, save it on the server, and put the old prefs back with a toast if the save fails. */
  const save = async (patch: VoiceUserPrefs) => {
    const prev = latest.current;
    const next = { ...prev, ...patch };
    const id = ++seq.current;
    applyPrefs(next);
    try {
      const saved = await putMe(ctx(), next);
      if (id === seq.current) applyPrefs(saved && typeof saved === 'object' ? ownPrefs(saved) : next);
    } catch {
      if (id === seq.current) applyPrefs(prev);
      toast(tr('host.set.saveFailed'), 'error');
    }
  };

  const ttsModes = status?.ttsModes ?? [];
  const ttsMode: TtsMode = prefs.ttsMode ?? 'balanced';
  const bargeIn = prefs.bargeIn ?? SHOWN.bargeIn;

  let body: React.ReactNode;
  if (loadErr) {
    body = (
      <>
        <Hint danger={loadErr !== 'off'}>
          {tr(loadErr === 'off' ? 'host.set.off' : loadErr === 'unreachable' ? 'host.set.unreachable' : 'host.set.loadFailed')}
        </Hint>
        {loadErr !== 'off' && (
          <View style={styles.row}><Btn small label={tr('voice.voices.reload')} disabled={loading} onPress={() => void load()} /></View>
        )}
      </>
    );
  } else if (!status) {
    body = <Hint>{tr('voice.voices.loading')}</Hint>;
  } else if (status.mode === 'off') {
    body = <Hint>{tr('host.set.off')}</Hint>;
  } else {
    body = (
      <>
        <Section title={tr('voice.set.style')} first />
        <Label>{tr('voice.set.ttsMode')}</Label>
        <Segmented<TtsMode>
          value={ttsMode}
          onChange={(m) => void save({ ttsMode: m })}
          options={TTS_MODES.map((o) => ({ value: o.value, label: tr(o.label), disabled: !ttsModes.includes(o.value) }))}
        />
        <Stepper
          label={tr('voice.set.speed')}
          value={effectiveSpeed(prefs)}
          min={0.5}
          max={2}
          step={0.1}
          format={(n) => n.toFixed(1)}
          onChange={(n) => void save({ speed: n })}
        />
        <Stepper
          label={tr('voice.set.pauseScale')}
          value={prefs.pauseScale ?? SHOWN.pauseScale}
          min={0}
          max={2}
          step={0.1}
          format={(n) => n.toFixed(1)}
          onChange={(n) => void save({ pauseScale: n })}
        />
        <Stepper
          label={tr('voice.set.responseDelayMs')}
          value={prefs.responseDelayMs ?? SHOWN.responseDelayMs}
          min={0}
          max={3000}
          step={100}
          format={(n) => `${n} ms`}
          onChange={(n) => void save({ responseDelayMs: n })}
        />
        <Stepper
          label={tr('voice.set.endOfTurnMs')}
          value={prefs.endOfTurnMs ?? SHOWN.endOfTurnMs}
          min={200}
          max={3000}
          step={50}
          format={(n) => `${n} ms`}
          onChange={(n) => void save({ endOfTurnMs: n })}
        />

        <Section title={tr('voice.set.bargeInTitle')} />
        <Check label={tr('voice.set.bargeIn')} value={bargeIn} onChange={(x) => void save({ bargeIn: x })} />
        <Stepper
          label={tr('voice.set.bargeInDb')}
          value={prefs.bargeInDb ?? SHOWN.bargeInDb}
          min={-70}
          max={-10}
          step={5}
          format={(n) => `${n} dB`}
          disabled={!bargeIn}
          onChange={(n) => void save({ bargeInDb: n })}
        />
        <Hint>{tr('voice.set.bargeInDbHint')}</Hint>

        <Section title={tr('voice.call.codec')} />
        <Segmented<VoiceCodec>
          value={voice.codec}
          onChange={(c) => setDevice({ voice: { codec: c } })}
          options={CODECS.map((o) => ({ value: o.value, label: tr(o.label) }))}
        />
        <Hint>{tr('voice.call.codecHint')}</Hint>

        <Section title={tr('host.set.callsTitle')} />
        <Check
          label={tr('host.set.pushToTalk')}
          hint={tr('host.set.pushToTalkHint')}
          value={voice.pushToTalk}
          onChange={(x) => setDevice({ voice: { pushToTalk: x } })}
        />
        <Check
          label={tr('host.set.privateDefault')}
          hint={voice.privateDefault ? tr('host.set.privateNotice') : undefined}
          value={voice.privateDefault}
          onChange={(x) => setDevice({ voice: { privateDefault: x } })}
        />

        {usage && (
          <>
            <Section title={tr('host.set.usageTitle')} />
            <Hint>{tr('host.set.usageValue', { ...callTimeParts(usage.callSeconds), turns: Number(usage.turns) || 0 })}</Hint>
          </>
        )}

        <VoiceServerVoicesCard ttsMode={ttsMode} current={prefs.voice ?? ''} onChoose={(id) => void save({ voice: id || undefined })} />

        <DiagnosePanel />
      </>
    );
  }

  return (
    <PageFrame title={tr('settings.page.voice')} onBack={onBack}>
      <View style={{ gap: 6 }}>{body}</View>
    </PageFrame>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
});
