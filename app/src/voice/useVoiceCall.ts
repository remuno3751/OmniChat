// One Aria voice call from the chat screen. The call goes through the OmniChat server's /voice/ws relay
// (docs/design/ARIA-HOST.md); the server saves the messages, so the transcript is not kept here, except for a
// private call (not saved): then the live text is shown in the bar only.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getDevice } from '../deviceSettings';
import { getServerUrl, getToken } from '../api';
import { applyServerMsg } from './ariaProtocol';
import type { CallLine, ServerMsg } from './ariaProtocol';
import { createCall, supported } from './voiceEngine';
import type { CallState, VoiceCall } from './voiceEngine';
import { buildRelayUrl, getStatus, isAriaUnreachable, isVoiceOff, RECONNECT_MIN_MS } from './voiceApi';
import { closeErrorOf, manualReconnectWait, nextReconnectDelay, parseCloseDetail, shouldAutoReconnect } from './callLogic';
import type { CloseInfo } from './callLogic';

export type VoiceCallError = 'off' | 'busy' | 'quota' | 'unreachable' | 'mic-denied' | 'unsupported' | 'failed';
type Settings = Record<string, number | string | boolean>;

const NO_LINES: CallLine[] = [];

export interface VoiceCallHook {
  state: CallState;
  error: VoiceCallError | null;
  muted: boolean;
  /** Aria is speaking (reply audio playing) */
  speaking: boolean;
  /** the user's speech is being heard (speech_start .. speech_end) */
  listening: boolean;
  /** microphone level 0..1 */
  micLevel: number;
  /** from `ready`: the ttsMode values this server offers */
  ttsModes: string[] | null;
  /** from `ready`: the conversation the server saved the call into */
  conversationId: string | null;
  /** from `ready`: the server confirmed that this call is not saved (private) */
  serverPrivate: boolean;
  /** live text of a private call (empty for a saved call: the chat shows it) */
  lines: CallLine[];
  /** latest latency from the relay (omni_stats), ms */
  latencyMs: number | null;
  /** push-to-talk (device setting, read when the call connects): the mic is on only while talk(true) */
  pushToTalk: boolean;
  /** sanitized close reason of the last drop (e.g. aria_restarting), or null */
  closeReason: string | null;
  /** epoch ms: a reconnect is not allowed before this time */
  retryAt: number;
  /** the relay URL of this call. It holds the token: pass it on, never show or log it */
  relayUrl: string | null;
  start(conversationId: string, priv?: boolean): Promise<void>;
  /** reconnects with the last call's arguments; does nothing before RECONNECT_MIN_MS has passed */
  reconnect(): void;
  stop(): void;
  toggleMute(): void;
  /** push-to-talk: mic on (true) or off (false); does nothing when push-to-talk is off */
  talk(on: boolean): void;
  interrupt(): void;
  sendText(text: string): void;
  updateSettings(values: Settings, persist: boolean): void;
}

function errorOf(detail: string | undefined): VoiceCallError {
  if (detail === 'mic-denied' || detail === 'mic-error') return 'mic-denied';
  if (detail === 'unsupported') return 'unsupported';
  return 'failed';
}

export function useVoiceCall(): VoiceCallHook {
  const [state, setState] = useState<CallState>('idle');
  const [error, setError] = useState<VoiceCallError | null>(null);
  const [muted, setMuted] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [ttsModes, setTtsModes] = useState<string[] | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [serverPrivate, setServerPrivate] = useState(false);
  const [lines, setLines] = useState<CallLine[]>(NO_LINES);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [pushToTalk, setPushToTalk] = useState(false);
  const [closeReason, setCloseReason] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState(0);
  const [relayUrl, setRelayUrl] = useState<string | null>(null);

  const callRef = useRef<VoiceCall | null>(null);
  /** each connect() gets a run number; events from an older run (or after stop) are ignored */
  const runRef = useRef(0);
  const mutedRef = useRef(false);
  /** `ready` has arrived on the current call */
  const readyRef = useRef(false);
  /** push-to-talk is on for this call */
  const pttRef = useRef(false);
  /** this call was asked to be private (its text is collected for the bar) */
  const privRef = useRef(false);
  /** the arguments of the last start(): a reconnect uses them */
  const lastArgsRef = useRef<{ convId: string; priv: boolean } | null>(null);
  /** when the last attempt started (epoch ms) */
  const lastAttemptRef = useRef<number | null>(null);
  /** automatic retries used since the last ready */
  const autoRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** ends the call, clears the refs and any pending retry; sets no state (safe on unmount) */
  const teardown = useCallback(() => {
    runRef.current++;
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const c = callRef.current;
    callRef.current = null;
    c?.stop();
  }, []);

  const stop = useCallback(() => {
    teardown();
    autoRef.current = 0;
    lastArgsRef.current = null;
    lastAttemptRef.current = null;
    setState('idle');
    setError(null);
    setSpeaking(false);
    setListening(false);
    setMicLevel(0);
    setTtsModes(null);
    setConversationId(null);
    setServerPrivate(false);
    setLines(NO_LINES);
    setLatencyMs(null);
    setCloseReason(null);
    setRetryAt(0);
    setRelayUrl(null);
  }, [teardown]);

  // leaving the screen ends the call
  useEffect(() => () => teardown(), [teardown]);

  // one attempt: checks the server, then opens the call. Also used by the reconnect button and the automatic retry.
  const connect: (convId: string, priv: boolean) => Promise<void> = useCallback(async (convId: string, priv: boolean) => {
    teardown();
    const run = runRef.current;
    const live = () => runRef.current === run;
    const now = Date.now();
    lastAttemptRef.current = now;
    setRetryAt(now + RECONNECT_MIN_MS);
    readyRef.current = false;
    privRef.current = priv;
    pttRef.current = getDevice().voice.pushToTalk;
    setPushToTalk(pttRef.current);

    setError(null);
    setSpeaking(false);
    setListening(false);
    setMicLevel(0);
    setTtsModes(null);
    setConversationId(null);
    setServerPrivate(false);
    setLines(NO_LINES);
    setLatencyMs(null);
    setCloseReason(null);
    setRelayUrl(null);
    if (!supported) {
      setState('error');
      setError('unsupported');
      return;
    }
    setState('connecting');

    const base = getServerUrl();
    const token = getToken();
    // a plain HTTP check first: it tells "voice is off" and "Aria cannot be reached" apart from a failed socket
    let pre: VoiceCallError | null = null;
    try {
      const st = await getStatus({ base, token });
      if (st.mode === 'off') pre = 'off';
      else if (!st.ready) pre = 'unreachable';
    } catch (e) {
      pre = isVoiceOff(e) ? 'off' : isAriaUnreachable(e) ? 'unreachable' : 'failed';
    }
    if (!live()) return;
    const url = pre ? null : buildRelayUrl(base, token, convId, priv);
    if (pre || !url) {
      setState('error');
      setError(pre ?? 'failed');
      return;
    }
    setRelayUrl(url);

    const fail = (e: VoiceCallError) => {
      teardown(); // stops the engine; its own events from this run are ignored from now on
      setState('error');
      setError(e);
      setSpeaking(false);
      setListening(false);
    };

    const call = createCall(
      { url, settings: {}, micEnabled: !pttRef.current && !mutedRef.current, codec: getDevice().voice.codec },
      {
        onState(s, detail) {
          if (!live()) return;
          if (s === 'ready') {
            autoRef.current = 0;
            setState('ready');
            // no microphone: the call goes on as text
            if (detail === 'mic-denied' || detail === 'mic-error') setError('mic-denied');
            return;
          }
          if (s === 'closed') {
            const info: CloseInfo = parseCloseDetail(detail);
            setCloseReason(info.reason ?? null);
            const e = closeErrorOf(info);
            if (e) {
              // 4409 (voice off), 4429 (busy or quota): the server said no; no retry
              fail(e);
              return;
            }
            // an unexpected close: the call was dropped, or the socket never opened
            callRef.current = null;
            setSpeaking(false);
            setListening(false);
            setMicLevel(0);
            if (readyRef.current) {
              setState('closed');
            } else {
              setState('error');
              setError('unreachable');
            }
            const delay = nextReconnectDelay(Date.now(), lastAttemptRef.current, autoRef.current);
            const args = lastArgsRef.current;
            if (delay !== null && args && shouldAutoReconnect(info)) {
              autoRef.current++;
              reconnectTimerRef.current = setTimeout(() => {
                reconnectTimerRef.current = null;
                void connect(args.convId, args.priv);
              }, delay);
            }
            return;
          }
          if (s === 'error') fail(errorOf(detail));
          else setState(s);
        },
        onMessage(msg: ServerMsg) {
          if (!live()) return;
          if (msg.type === 'speech_start') setListening(true);
          else if (msg.type === 'speech_end') setListening(false);
          else if (msg.type === 'ready') {
            readyRef.current = true;
            setTtsModes(msg.ttsModes);
            if (typeof msg.conversationId === 'string') setConversationId(msg.conversationId);
            setServerPrivate(msg.private === true);
          } else if (msg.type === 'omni_stats') {
            setLatencyMs(msg.latencyMs);
          }
          if (privRef.current) setLines((prev) => applyServerMsg(prev, msg));
        },
        onMicLevel(l) {
          if (live()) setMicLevel(l);
        },
        onSpeaking(s) {
          if (live()) setSpeaking(s);
        },
      },
    );
    callRef.current = call;
    try {
      await call.start();
    } catch {
      if (live()) fail('failed');
    }
  }, [teardown]);

  const start = useCallback(async (convId: string, priv = false) => {
    if (callRef.current) return;
    lastArgsRef.current = { convId, priv };
    autoRef.current = 0;
    lastAttemptRef.current = null;
    await connect(convId, priv);
  }, [connect]);

  const reconnect = useCallback(() => {
    const args = lastArgsRef.current;
    if (!args || manualReconnectWait(Date.now(), lastAttemptRef.current) > 0) return;
    void connect(args.convId, args.priv);
  }, [connect]);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    callRef.current?.setMicEnabled(!next);
  }, []);

  const talk = useCallback((on: boolean) => {
    if (pttRef.current) callRef.current?.setMicEnabled(on);
  }, []);

  const interrupt = useCallback(() => callRef.current?.interrupt(), []);
  const sendText = useCallback((text: string) => callRef.current?.sendText(text), []);
  const updateSettings = useCallback((values: Settings, persist: boolean) => callRef.current?.updateSettings(values, persist), []);

  return {
    state, error, muted, speaking, listening, micLevel, ttsModes, conversationId,
    serverPrivate, lines: serverPrivate ? lines : NO_LINES, latencyMs, pushToTalk, closeReason, retryAt, relayUrl,
    start, reconnect, stop, toggleMute, talk, interrupt, sendText, updateSettings,
  };
}
