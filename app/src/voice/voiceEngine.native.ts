// Aria 音声通話のネイティブ(Android)版。react-native-audio-api で、マイク取り込みと再生をする。
// 作りは voiceEngine.web.ts と同じ。設計と選定理由: docs/design/ARIA-VOICE-ANDROID.md

import { Platform } from 'react-native';
import { AudioContext, AudioManager, AudioRecorder } from 'react-native-audio-api';
import type { AudioBufferSourceNode } from 'react-native-audio-api';
import {
  downsampleTo16k,
  floatToPcm16,
  parseServerMessage,
  pcm16ToFloat,
  pcmChunkDurationSec,
  TurnGate,
} from './ariaProtocol';
import type { ClientMsg, ServerMsg } from './ariaProtocol';
import type { CallEvents, CallOptions, VoiceCall } from './voiceEngine';

export const supported: boolean = Platform.OS === 'android' && typeof WebSocket !== 'undefined';

const PING_MS = 20000;
const LEVEL_MS = 100;
const START_DELAY_SEC = 0.03;
const CAPTURE_RATE = 16000;
const CAPTURE_FRAMES = 320; // 20 ms

/**
 * react-native-audio-api 0.13 は、マイクを VOICE_COMMUNICATION で開けず、エコー除去が効かない。
 * スピーカーの音を拾って、自分の声と取り違えないように、返事を再生している間は、マイクの音を送らない。
 * 割り込みは、画面の割り込みボタン(interrupt)で行う。
 */
const MUTE_MIC_WHILE_SPEAKING = true;

/** 受信した audio の直後に来る、バイナリ(PCM16)の待ち状態 */
interface PendingAudio {
  turn: number;
  sampleRate: number;
  remaining: number;
}

function rms(input: Float32Array): number {
  if (input.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
  return Math.min(1, Math.sqrt(sum / input.length));
}

export function createCall(opts: CallOptions, events: CallEvents): VoiceCall {
  const gate = new TurnGate();
  const playing = new Set<AudioBufferSourceNode>();

  let started = false;
  let stopped = false;
  let stopCalled = false;
  let closedNotified = false;
  let readyEmitted = false;
  let micAttempted = false;
  let micDetail: string | undefined;
  let micOn = opts.micEnabled;
  let speaking = false;
  let pendingAudio: PendingAudio | null = null;
  let nextTime = 0;
  let lastLevelAt = 0;

  let socket: WebSocket | null = null;
  let ctx: AudioContext | null = null;
  let recorder: AudioRecorder | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  function setSpeaking(v: boolean): void {
    if (speaking === v) return;
    speaking = v;
    events.onSpeaking(v);
  }

  function reportError(detail: string): void {
    events.onState('error', detail);
  }

  /** 失敗: 資源を全部閉じてから error を出す */
  function fail(detail: string): void {
    if (stopped) return;
    release();
    reportError(detail);
  }

  function sendJson(msg: ClientMsg): void {
    const s = socket;
    if (!s || s.readyState !== WebSocket.OPEN) return;
    try {
      s.send(JSON.stringify(msg));
    } catch {
      fail('send');
    }
  }

  function stopPlayback(): void {
    for (const node of playing) {
      node.onEnded = null;
      try {
        node.stop();
      } catch {
        // 再生が終わっているノードの stop は無視する
      }
    }
    playing.clear();
    nextTime = 0;
    setSpeaking(false);
  }

  /** マイク・再生・ソケット・AudioContext を閉じる。何度呼んでもよい */
  function release(): void {
    if (stopped) return;
    stopped = true;

    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }

    const s = socket;
    socket = null;
    if (s) {
      s.onopen = null;
      s.onmessage = null;
      s.onerror = null;
      s.onclose = null;
      try {
        s.close();
      } catch {
        // 閉じるだけなので、例外は無視する
      }
    }

    stopPlayback();

    const r = recorder;
    recorder = null;
    if (r) {
      try {
        r.clearOnAudioReady();
        r.clearOnError();
        r.disconnect();
        void r.stop().catch(() => undefined);
      } catch {
        // 停止の失敗は無視する
      }
    }

    const c = ctx;
    ctx = null;
    if (c) {
      try {
        c.close().catch(() => undefined);
      } catch {
        // close の失敗は無視する
      }
    }
  }

  /** 切断の終わり。closed は一度だけ出す。4409(voice_off)・4429(busy)は detail に 'code:<n>' を載せる */
  function finish(detail?: string): void {
    release();
    if (!closedNotified) {
      closedNotified = true;
      events.onState('closed', detail);
    }
  }

  function reportMic(detail: string): void {
    micDetail = detail;
    if (readyEmitted && !stopped) events.onState('ready', detail);
  }

  function onMicBlock(input: Float32Array, inRate: number): void {
    if (stopped) return;
    const now = Date.now();
    if (now - lastLevelAt >= LEVEL_MS) {
      lastLevelAt = now;
      events.onMicLevel(micOn ? rms(input) : 0);
    }
    const s = socket;
    if (!micOn || !s || s.readyState !== WebSocket.OPEN) return;
    if (MUTE_MIC_WHILE_SPEAKING && speaking) return;
    const pcm = floatToPcm16(downsampleTo16k(input, inRate));
    try {
      s.send(pcm.buffer as ArrayBuffer);
    } catch {
      fail('send');
    }
  }

  async function setupMic(): Promise<void> {
    try {
      const perm = await AudioManager.requestRecordingPermissions();
      if (perm !== 'Granted') {
        reportMic('mic-denied');
        return;
      }
    } catch {
      reportMic('mic-denied');
      return;
    }
    if (stopped) return;

    try {
      const r = new AudioRecorder();
      const reg = r.onAudioReady(
        { sampleRate: CAPTURE_RATE, bufferLength: CAPTURE_FRAMES, channelCount: 1 },
        (e) => onMicBlock(e.buffer.getChannelData(0).slice(), e.buffer.sampleRate),
      );
      if (reg.status === 'error') throw new Error('onAudioReady');
      r.onError(() => {
        if (!stopped) reportMic('mic-error');
      });
      const res = await r.start();
      if (res.status === 'error') throw new Error('start');
      if (stopped) {
        void r.stop().catch(() => undefined);
        return;
      }
      recorder = r;
    } catch {
      reportMic('mic-error');
    }
  }

  function enqueue(c: AudioContext, data: ArrayBuffer, sampleRate: number): void {
    const samples = pcm16ToFloat(data);
    if (samples.length === 0) return;
    const rate = sampleRate >= 8000 && sampleRate <= 96000 ? sampleRate : c.sampleRate;
    try {
      const buf = c.createBuffer(1, samples.length, rate);
      buf.copyToChannel(new Float32Array(samples), 0);
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(c.destination);
      const startAt = Math.max(c.currentTime + START_DELAY_SEC, nextTime);
      src.onEnded = () => {
        playing.delete(src);
        if (playing.size === 0 && pendingAudio === null) setSpeaking(false);
      };
      playing.add(src);
      src.start(startAt);
      nextTime = startAt + pcmChunkDurationSec(data.byteLength, rate);
      setSpeaking(true);
    } catch {
      fail('audio');
    }
  }

  function onBinary(data: ArrayBuffer): void {
    const p = pendingAudio;
    if (!p) return;
    p.remaining -= 1;
    if (p.remaining <= 0) pendingAudio = null;
    if (stopped || !ctx || !gate.accept(p.turn)) return;
    enqueue(ctx, data, p.sampleRate);
  }

  function handleMessage(msg: ServerMsg): void {
    events.onMessage(msg);
    switch (msg.type) {
      case 'ready':
        if (!readyEmitted) {
          readyEmitted = true;
          events.onState('ready', micDetail);
        }
        break;
      case 'turn_start':
        gate.start(msg.turn);
        break;
      case 'interrupted':
        gate.interrupt(msg.turn);
        stopPlayback();
        break;
      case 'audio':
        pendingAudio = msg.frames > 0 ? { turn: msg.turn, sampleRate: msg.sampleRate, remaining: msg.frames } : null;
        break;
      default:
        break;
    }
  }

  async function start(): Promise<void> {
    if (started || stopped) return;
    started = true;

    const url = opts.url;
    if (!url) {
      reportError('bad-url');
      return;
    }
    events.onState('connecting');

    let c: AudioContext;
    try {
      c = new AudioContext();
      ctx = c;
      await c.resume();
    } catch {
      fail('audio');
      return;
    }
    if (stopped) return;

    let s: WebSocket;
    try {
      s = new WebSocket(url);
    } catch {
      fail('socket');
      return;
    }
    s.binaryType = 'arraybuffer';
    socket = s;

    s.onopen = () => {
      const hello: ClientMsg = opts.voice
        ? { type: 'hello', codec: 'pcm16', voice: opts.voice, settings: opts.settings }
        : { type: 'hello', codec: 'pcm16', settings: opts.settings };
      sendJson(hello);
      if (stopped) return;
      pingTimer = setInterval(() => sendJson({ type: 'ping' }), PING_MS);
    };
    s.onmessage = (ev: { data: unknown }) => {
      if (typeof ev.data === 'string') {
        const msg = parseServerMessage(ev.data);
        if (msg) handleMessage(msg);
      } else if (ev.data instanceof ArrayBuffer) {
        onBinary(ev.data);
      }
    };
    s.onerror = () => {
      // 続けて close が来るので、資源はそこで閉じる
      if (!stopped) reportError('socket');
    };
    s.onclose = (ev: { code?: number }) => finish(ev.code === 4409 || ev.code === 4429 ? `code:${ev.code}` : undefined);

    if (opts.micEnabled) {
      micAttempted = true;
      void setupMic();
    }
  }

  return {
    start,
    sendText(text: string): void {
      if (!text.trim()) return;
      sendJson({ type: 'text', text });
    },
    interrupt(): void {
      sendJson({ type: 'interrupt' });
      stopPlayback();
      gate.interrupt();
    },
    updateSettings(values, persist): void {
      sendJson({ type: 'settings', values, persist });
    },
    setMicEnabled(on: boolean): void {
      micOn = on;
      // 最初はマイクなしで始めた場合、初めてオンにしたときに取る
      if (on && !micAttempted && !stopped) {
        micAttempted = true;
        void setupMic();
      }
    },
    stop(): void {
      if (stopCalled) return;
      stopCalled = true;
      finish();
    },
  };
}
