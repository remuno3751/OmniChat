// Aria 音声通話の Web 版。WebSocket・マイク・再生はこのファイルだけで使う(Node では読み込めなくてよい)。
// 設計: docs/design/ARIA-VOICE.md。型は ./voiceEngine と同じ内容。

import {
  ARIA_SAMPLE_RATE_IN,
  downsampleTo16k,
  FrameChunker,
  floatToPcm16,
  opusFrameSamples,
  opusInputRate,
  OPUS_RECV_RATE,
  parseServerMessage,
  pcm16ToFloat,
  pcmChunkDurationSec,
  resolveCodec,
  TurnGate,
} from './ariaProtocol';
import type { ClientMsg, ServerMsg } from './ariaProtocol';
import { createOpusDecoder, createOpusEncoder, opusSupported } from './opusCodec.web';
import type { OpusDecoderHandle, OpusEncoderHandle } from './opusCodec.web';
import type { CallEvents, CallOptions, VoiceCall } from './voiceEngine';
import { closeDetail } from './callLogic';

export const supported: boolean =
  typeof window !== 'undefined' && typeof WebSocket !== 'undefined' && typeof AudioContext !== 'undefined';

const PING_MS = 20000;
const LEVEL_MS = 100;
const START_DELAY_SEC = 0.03;
// push-to-talk release: this much silence tells the server's VAD that the utterance has ended
const SILENCE_MS = 600;

// 128 サンプルずつ届く入力を 20 ms 分ためて送るだけのプロセッサ
const WORKLET_SOURCE = `
class AriaCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.max(1, Math.round(sampleRate * 0.02));
    this.buf = new Float32Array(this.size);
    this.fill = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    let i = 0;
    while (i < input.length) {
      const n = Math.min(this.size - this.fill, input.length - i);
      this.buf.set(input.subarray(i, i + n), this.fill);
      this.fill += n;
      i += n;
      if (this.fill === this.size) {
        this.port.postMessage(this.buf.slice(0));
        this.fill = 0;
      }
    }
    return true;
  }
}
registerProcessor('aria-capture', AriaCapture);
`;

/** 受信した audio の直後に来る、バイナリ(PCM16)の待ち状態 */
interface PendingAudio {
  turn: number;
  sampleRate: number;
  remaining: number;
  codec: string;
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
  let useOpus = false;
  let opusDec: OpusDecoderHandle | null = null;
  let opusEnc: OpusEncoderHandle | null = null;
  let chunker: FrameChunker | null = null;
  let lastLevelAt = 0;

  let socket: WebSocket | null = null;
  let ctx: AudioContext | null = null;
  let micStream: MediaStream | null = null;
  let captureNodes: AudioNode[] = [];
  let scriptNode: ScriptProcessorNode | null = null;
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
      node.onended = null;
      node.stop();
    }
    playing.clear();
    nextTime = 0;
    opusDec?.flush();
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

    opusEnc?.close();
    opusEnc = null;
    opusDec?.close();
    opusDec = null;
    stopPlayback();

    if (scriptNode) {
      scriptNode.onaudioprocess = null;
    }
    for (const n of [...captureNodes, scriptNode]) {
      try {
        n?.disconnect();
      } catch {
        // disconnect の失敗は無視する
      }
    }
    captureNodes = [];
    scriptNode = null;

    if (micStream) {
      for (const t of micStream.getTracks()) t.stop();
      micStream = null;
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

  /** 切断の終わり。closed は一度だけ出す。detail は closeDetail(): 'code:4409' 等と 'reason:<text>'(callLogic.ts) */
  function finish(detail?: string): void {
    release();
    if (!closedNotified) {
      closedNotified = true;
      events.onState('closed', detail);
    }
  }

  /** pcm16 only: silence after the mic is switched off (push-to-talk release), so the server ends the utterance */
  function sendSilence(): void {
    const s = socket;
    if (useOpus || stopped || !s || s.readyState !== WebSocket.OPEN) return;
    try {
      s.send(new Int16Array(Math.round((ARIA_SAMPLE_RATE_IN * SILENCE_MS) / 1000)).buffer);
    } catch {
      fail('send');
    }
  }

  function reportMic(detail: string): void {
    micDetail = detail;
    if (readyEmitted && !stopped) events.onState('ready', detail);
  }

  function onMicBlock(c: AudioContext, input: Float32Array): void {
    if (stopped) return;
    const now = Date.now();
    if (now - lastLevelAt >= LEVEL_MS) {
      lastLevelAt = now;
      events.onMicLevel(micOn ? rms(input) : 0);
    }
    const s = socket;
    if (!micOn || !s || s.readyState !== WebSocket.OPEN) return;
    if (useOpus) {
      if (!opusEnc || !chunker) return;
      const src = c.sampleRate === 48000 ? input : downsampleTo16k(input, c.sampleRate);
      for (const frame of chunker.push(src)) opusEnc.encode(frame);
      return;
    }
    const pcm = floatToPcm16(downsampleTo16k(input, c.sampleRate));
    try {
      s.send(pcm.buffer as ArrayBuffer);
    } catch {
      fail('send');
    }
  }

  async function setupMic(c: AudioContext): Promise<void> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch {
      reportMic('mic-denied');
      return;
    }
    if (stopped) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    micStream = stream;
    for (const t of stream.getAudioTracks()) t.enabled = micOn;

    try {
      const src = c.createMediaStreamSource(stream);
      // 出力は無音にして destination につなぐ(ワークレットや ScriptProcessor を回すため)
      const mute = c.createGain();
      mute.gain.value = 0;
      mute.connect(c.destination);
      captureNodes = [src, mute];

      let usedWorklet = false;
      if (c.audioWorklet) {
        const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
        try {
          await c.audioWorklet.addModule(url);
          if (stopped) return;
          const node = new AudioWorkletNode(c, 'aria-capture', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
          });
          node.port.onmessage = (e: MessageEvent) => onMicBlock(c, e.data as Float32Array);
          captureNodes.push(node);
          src.connect(node);
          node.connect(mute);
          usedWorklet = true;
        } catch {
          usedWorklet = false;
        } finally {
          URL.revokeObjectURL(url);
        }
      }

      if (!usedWorklet) {
        if (stopped) return;
        const proc = c.createScriptProcessor(2048, 1, 1);
        proc.onaudioprocess = (e) => onMicBlock(c, e.inputBuffer.getChannelData(0).slice());
        scriptNode = proc;
        src.connect(proc);
        proc.connect(mute);
      }
    } catch {
      reportMic('mic-error');
    }
  }

  function enqueue(c: AudioContext, samples: Float32Array, sampleRate: number): void {
    if (samples.length === 0) return;
    const rate = sampleRate >= 3000 && sampleRate <= 768000 ? sampleRate : c.sampleRate;
    try {
      const buf = c.createBuffer(1, samples.length, rate);
      buf.getChannelData(0).set(samples);
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(c.destination);
      const startAt = Math.max(c.currentTime + START_DELAY_SEC, nextTime);
      src.onended = () => {
        playing.delete(src);
        if (playing.size === 0 && pendingAudio === null) setSpeaking(false);
      };
      playing.add(src);
      src.start(startAt);
      nextTime = startAt + pcmChunkDurationSec(samples.length * 2, rate);
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
    if (p.codec === 'opus') {
      if (opusDec) opusDec.decode(data, p.turn);
      return;
    }
    enqueue(ctx, pcm16ToFloat(data), p.sampleRate);
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
        pendingAudio =
          msg.frames > 0
            ? { turn: msg.turn, sampleRate: msg.sampleRate, remaining: msg.frames, codec: msg.codec || (useOpus ? 'opus' : 'pcm16') }
            : null;
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

    // AudioContext は、ボタンを押した操作の中で作る
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

    // Opus は WebCodecs が使えるときだけ。使えなければ pcm16 に戻す
    const want = opts.codec ?? 'pcm16';
    const sendRate = opusInputRate(c.sampleRate);
    const opusOk = want === 'opus' && sendRate !== null && (await opusSupported(sendRate));
    if (stopped) return;
    const chosen = resolveCodec(want, opusOk);
    if (chosen.codec === 'opus' && sendRate !== null) {
      try {
        opusDec = createOpusDecoder(
          (samples, turn) => {
            if (!stopped && ctx && gate.accept(turn)) enqueue(ctx, samples, OPUS_RECV_RATE);
          },
          () => fail('audio'),
        );
        opusEnc = createOpusEncoder(
          sendRate,
          (packet) => {
            const sock = socket;
            if (!micOn || !sock || sock.readyState !== WebSocket.OPEN) return;
            try {
              sock.send(packet);
            } catch {
              fail('send');
            }
          },
          () => fail('audio'),
        );
        chunker = new FrameChunker(opusFrameSamples(sendRate));
        useOpus = true;
      } catch {
        opusDec?.close();
        opusEnc?.close();
        opusDec = null;
        opusEnc = null;
        chosen.codec = 'pcm16';
        chosen.fellBack = true;
      }
    }
    events.onCodec?.(chosen.codec, chosen.fellBack);

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
        ? { type: 'hello', codec: useOpus ? 'opus' : 'pcm16', voice: opts.voice, settings: opts.settings }
        : { type: 'hello', codec: useOpus ? 'opus' : 'pcm16', settings: opts.settings };
      sendJson(hello);
      if (stopped) return;
      pingTimer = setInterval(() => sendJson({ type: 'ping' }), PING_MS);
    };
    s.onmessage = (ev: MessageEvent) => {
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
    s.onclose = (ev: { code?: number; reason?: string }) => finish(closeDetail(ev.code, ev.reason));

    if (opts.micEnabled) {
      micAttempted = true;
      void setupMic(c);
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
      if (micOn && !on) sendSilence();
      micOn = on;
      if (micStream) {
        for (const t of micStream.getAudioTracks()) t.enabled = on;
      }
      // 最初はマイクなしで始めた場合、初めてオンにしたときに取る
      if (on && !micAttempted && ctx && !stopped) {
        micAttempted = true;
        void setupMic(ctx);
      }
    },
    stop(): void {
      if (stopCalled) return;
      stopCalled = true;
      finish();
    },
  };
}
