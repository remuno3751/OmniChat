// Aria 音声通話の純粋なロジック。React / react-native / ブラウザ API は使わない(node でテストできる)。
// 契約の正は Aria 側の docs/current/OMNICHAT_VOICE_CONTRACT.md。設計は docs/design/ARIA-VOICE.md。

import { effectiveSpeed } from './voiceApi';
import type { VoiceUserPrefs } from './voiceApi';

export const ARIA_SAMPLE_RATE_IN = 16000;
export type TtsMode = 'balanced' | 'fast';

/** クライアント → サーバーの JSON */
export type ClientMsg =
  | { type: 'hello'; codec: 'pcm16' | 'opus'; voice?: string; settings?: Record<string, number | string | boolean> }
  | { type: 'settings'; values: Record<string, number | string | boolean>; persist?: boolean }
  | { type: 'text'; text: string }
  | { type: 'interrupt' }
  | { type: 'ping' };

/** サーバー → クライアントの JSON(未知の type は 'unknown' にして捨てない) */
export type ServerMsg =
  | { type: 'ready'; codec: string; sampleRate: number; session?: string; settings?: Record<string, unknown>; ttsModes: string[]; conversationId?: string; private?: boolean }
  | { type: 'settings'; settings: Record<string, unknown>; changed: string[]; rejected: string[] }
  | { type: 'turn_start'; turn: number }
  | { type: 'speech_start' }
  | { type: 'speech_end' }
  | { type: 'transcript'; turn: number; text: string; final: boolean; source: string }
  | { type: 'transcript_retract'; turn?: number }
  | { type: 'text'; turn: number; delta: string }
  | { type: 'audio'; turn: number; seq: number; text: string; codec: string; sampleRate: number; frames: number }
  | { type: 'turn_end'; turn: number; interrupted: boolean }
  | { type: 'interrupted'; turn: number }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' }
  /** OmniChat relay: time from the text / end of speech to the first audio (ms) */
  | { type: 'omni_stats'; latencyMs: number }
  | { type: 'unknown'; raw: unknown };

type Dict = Record<string, unknown>;

function isObject(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * 入力の URL(http/https/ws/wss)を ws / wss の /live/ws に直し、?user= と ?token= を付ける。不正なら null。
 * http → ws、https → wss。末尾のパスは /live/ws に置き換える。
 */
export function buildLiveUrl(base: string, user: string, token: string): string | null {
  const raw = (base ?? '').trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  let protocol: string;
  if (u.protocol === 'http:' || u.protocol === 'ws:') protocol = 'ws:';
  else if (u.protocol === 'https:' || u.protocol === 'wss:') protocol = 'wss:';
  else return null;
  if (!u.hostname) return null;
  u.protocol = protocol;
  u.pathname = '/live/ws';
  u.hash = '';
  const params = new URLSearchParams();
  const who = (user ?? '').trim();
  params.set('user', who || 'default');
  if (token) params.set('token', token);
  u.search = params.toString();
  return u.toString();
}

/**
 * サーバーの JSON 文字列を ServerMsg にする。JSON でない、オブジェクトでない、type が無いときは null。
 * 既知の type は camelCase に直す(sample_rate → sampleRate、tts_modes → ttsModes)。
 */
export function parseServerMessage(text: string): ServerMsg | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(obj) || typeof obj.type !== 'string') return null;
  const type = obj.type;
  switch (type) {
    case 'ready': {
      const msg: ServerMsg = {
        type: 'ready',
        codec: str(obj.codec),
        sampleRate: num(obj.sample_rate),
        ttsModes: strList(obj.tts_modes),
      };
      if (typeof obj.session === 'string') msg.session = obj.session;
      if (isObject(obj.settings)) msg.settings = obj.settings;
      // the relay adds these two (ARIA-HOST.md): the saved conversation, and whether the call is not saved
      if (typeof obj.conversationId === 'string') msg.conversationId = obj.conversationId;
      if (typeof obj.private === 'boolean') msg.private = obj.private;
      return msg;
    }
    case 'settings':
      return {
        type: 'settings',
        settings: isObject(obj.settings) ? obj.settings : {},
        changed: strList(obj.changed),
        rejected: strList(obj.rejected),
      };
    case 'turn_start':
      return { type: 'turn_start', turn: num(obj.turn) };
    case 'speech_start':
      return { type: 'speech_start' };
    case 'speech_end':
      return { type: 'speech_end' };
    case 'transcript':
      return {
        type: 'transcript',
        turn: num(obj.turn),
        text: str(obj.text),
        final: obj.final === true,
        source: str(obj.source),
      };
    case 'transcript_retract':
      return typeof obj.turn === 'number' ? { type: 'transcript_retract', turn: obj.turn } : { type: 'transcript_retract' };
    case 'text':
      return { type: 'text', turn: num(obj.turn), delta: str(obj.delta) };
    case 'audio':
      return {
        type: 'audio',
        turn: num(obj.turn),
        seq: num(obj.seq),
        text: str(obj.text),
        codec: str(obj.codec),
        sampleRate: num(obj.sample_rate),
        frames: num(obj.frames),
      };
    case 'turn_end':
      return { type: 'turn_end', turn: num(obj.turn), interrupted: obj.interrupted === true };
    case 'interrupted':
      return { type: 'interrupted', turn: num(obj.turn) };
    case 'error':
      return { type: 'error', code: str(obj.code), message: str(obj.message) };
    case 'pong':
      return { type: 'pong' };
    case 'omni_stats':
      return { type: 'omni_stats', latencyMs: num(obj.latencyMs) };
    default:
      return { type: 'unknown', raw: obj };
  }
}

// ---- 設定 ------------------------------------------------------------------------------------------

type Range = { min: number; max: number; int: boolean };
const NUMERIC_RANGES: Record<string, Range> = {
  speed: { min: 0.5, max: 2.0, int: false },
  pitch: { min: -0.15, max: 0.15, int: false },
  intonation: { min: 0, max: 2, int: false },
  volume: { min: 0, max: 2, int: false },
  pause_scale: { min: 0, max: 2, int: false },
  tempo_dynamics: { min: 0, max: 2, int: false },
  pre_ms: { min: 0, max: 1500, int: true },
  post_ms: { min: 0, max: 1500, int: true },
  response_delay_ms: { min: 0, max: 3000, int: true },
  end_of_turn_ms: { min: 200, max: 3000, int: true },
  barge_in_min_ms: { min: 100, max: 1500, int: true },
  barge_in_db: { min: -70, max: -10, int: false },
};
const VOICE_MAX_CHARS = 200;

/** 数値に直せる値だけ受ける(NaN・Infinity・空文字・真偽値は不可)。 */
function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 設定を契約書の範囲に丸める。未知のキーと型の違う値は捨てる。
 * 範囲外の数値は端に丸める。ms 系は整数に丸める。voice は 200 文字を超えると捨てる(丸めると別の声になるため)。
 */
export function clampAriaSettings(values: Record<string, unknown>): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  if (!isObject(values)) return out;
  for (const key of Object.keys(values)) {
    const v = values[key];
    const range = NUMERIC_RANGES[key];
    if (range) {
      let n = toFiniteNumber(v);
      if (n === null) continue;
      if (range.int) n = Math.round(n);
      out[key] = Math.min(range.max, Math.max(range.min, n));
      continue;
    }
    if (key === 'barge_in') {
      if (typeof v === 'boolean') out.barge_in = v;
      continue;
    }
    if (key === 'voice') {
      if (typeof v === 'string' && v.length <= VOICE_MAX_CHARS) out.voice = v;
      continue;
    }
    if (key === 'tts_mode') {
      if (v === 'balanced' || v === 'fast') out.tts_mode = v;
      continue;
    }
    // 未知のキーは捨てる
  }
  return out;
}

/**
 * The user's server prefs (VoiceUserPrefs) as the hello / settings values. speed is effectiveSpeed (balanced 1.3 unless
 * the user chose one); a pref that is not set is left out. Ranges are applied by clampAriaSettings.
 */
export function settingsFromPrefs(p: VoiceUserPrefs): Record<string, number | string | boolean> {
  return clampAriaSettings({
    tts_mode: p.ttsMode ?? 'balanced',
    speed: effectiveSpeed(p),
    pause_scale: p.pauseScale,
    response_delay_ms: p.responseDelayMs,
    end_of_turn_ms: p.endOfTurnMs,
    barge_in: p.bargeIn,
    barge_in_db: p.bargeInDb,
    voice: p.voice || undefined,
  });
}

/** 設定の差分: next のうち prev と値が違うキーだけ(通話中の settings メッセージに載せる)。 */
export function diffSettings(
  prev: Record<string, number | string | boolean>,
  next: Record<string, number | string | boolean>,
): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  for (const key of Object.keys(next)) {
    if (prev[key] !== next[key]) out[key] = next[key];
  }
  return out;
}

// ---- Opus -------------------------------------------------------------------------------------------

export const OPUS_FRAME_MS = 20;
export const OPUS_RECV_RATE = 48000;

/** 1 フレーム(20 ms)のサンプル数 */
export function opusFrameSamples(rate: number): number {
  return Math.round((rate * OPUS_FRAME_MS) / 1000);
}

/**
 * Opus で送るときの入力のレート。AudioContext が 48 kHz ならそのまま 48 kHz、16 kHz 以上なら 16 kHz に間引く。
 * 16 kHz 未満は null(Opus を使わない)。
 */
export function opusInputRate(ctxRate: number): 48000 | 16000 | null {
  if (ctxRate === 48000) return 48000;
  return ctxRate >= ARIA_SAMPLE_RATE_IN ? 16000 : null;
}

/** 希望のコーデックと、この環境で Opus が使えるかから、実際に使うコーデックを決める。fellBack は、Opus を望んだのに戻したとき true。 */
export function resolveCodec(want: 'pcm16' | 'opus', opusOk: boolean): { codec: 'pcm16' | 'opus'; fellBack: boolean } {
  if (want === 'opus' && !opusOk) return { codec: 'pcm16', fellBack: true };
  return { codec: want, fellBack: false };
}

/** 任意の長さで届くサンプルを、ちょうど frameSize 個ずつのフレームにして返す(余りは次回に持ち越す)。 */
export class FrameChunker {
  private buf: Float32Array;
  private fill = 0;

  constructor(private readonly frameSize: number) {
    this.buf = new Float32Array(Math.max(1, frameSize));
  }

  push(input: Float32Array): Float32Array[] {
    const out: Float32Array[] = [];
    let i = 0;
    while (i < input.length) {
      const n = Math.min(this.buf.length - this.fill, input.length - i);
      this.buf.set(input.subarray(i, i + n), this.fill);
      this.fill += n;
      i += n;
      if (this.fill === this.buf.length) {
        out.push(this.buf.slice(0));
        this.fill = 0;
      }
    }
    return out;
  }

  reset(): void {
    this.fill = 0;
  }
}

// ---- 音声の変換 --------------------------------------------------------------------------------------

/**
 * 16 kHz に間引く。inRate が 16000 以下ならそのまま返す(アップサンプルしない)。
 * 出力 1 サンプルは、対応する入力の範囲の平均。長さは floor(input.length * 16000 / inRate)。
 */
export function downsampleTo16k(input: Float32Array, inRate: number): Float32Array {
  if (!(inRate > ARIA_SAMPLE_RATE_IN)) return input;
  const outLen = Math.floor((input.length * ARIA_SAMPLE_RATE_IN) / inRate);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor((i * inRate) / ARIA_SAMPLE_RATE_IN);
    let end = Math.min(input.length, Math.floor(((i + 1) * inRate) / ARIA_SAMPLE_RATE_IN));
    if (end <= start) end = Math.min(input.length, start + 1);
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

/** -1..1 に丸めてから PCM16 にする。負は ×32768、正は ×32767、四捨五入。NaN は 0 にする。 */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const v = Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0;
    out[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
  }
  return out;
}

/**
 * PCM16 を -1..1 の Float32 にする。ArrayBuffer はリトルエンディアンとして読む(バイト長が奇数なら最後の 1 バイトは捨てる)。
 * Int16Array はそのまま使う。各値を 32768 で割る。
 */
export function pcm16ToFloat(data: ArrayBuffer | Int16Array): Float32Array {
  if (data instanceof Int16Array) {
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = data[i] / 32768;
    return out;
  }
  const n = Math.floor(data.byteLength / 2);
  const view = new DataView(data);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/** モノラル 16 bit の PCM の長さ(秒)。sampleRate が 0 以下なら 0。 */
export function pcmChunkDurationSec(byteLength: number, sampleRate: number): number {
  if (!(sampleRate > 0)) return 0;
  return byteLength / 2 / sampleRate;
}

// ---- ターン管理 ---------------------------------------------------------------------------------------

/**
 * どのターンのデータを受けてよいかを決める。古いターンと、中断されたターンのデータを捨てる。
 */
export class TurnGate {
  private _current = 0;
  private interrupted = new Set<number>();

  get current(): number {
    return this._current;
  }

  /** 現在より大きい turn なら現在を更新し、中断の記録を消す。小さい・同じ turn なら何もしない。 */
  start(turn: number): void {
    if (turn > this._current) {
      this._current = turn;
      this.interrupted.clear();
    }
  }

  /** そのターンを中断済みにする。turn 省略なら現在のターン。 */
  interrupt(turn: number = this._current): void {
    if (turn > this._current) this.start(turn);
    this.interrupted.add(turn);
  }

  /** このターンのデータを受けてよいか(現在のターン以降、かつ中断されていない)。 */
  accept(turn: number): boolean {
    return turn >= this._current && !this.interrupted.has(turn);
  }
}

// ---- 文字起こしの表示モデル ----------------------------------------------------------------------------

/** 通話の表示用の行 */
export interface CallLine {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  final: boolean;
  turn: number;
}

function userId(turn: number): string {
  return `u${turn}`;
}

function assistantId(turn: number): string {
  return `a${turn}`;
}

/**
 * サーバーのメッセージを表示用の行に反映する。入力の配列は変えず、新しい配列を返す(変化なしなら同じ配列)。
 * - transcript: user 行を更新。final=false の間は同じ行を書き換え、final=true で確定。
 * - transcript_retract: 最後の user 行を取り除く。
 * - text: assistant 行の末尾に delta を足す(無ければ作る。final は false)。
 * - turn_end / interrupted: そのターンの assistant 行を final にする。
 */
export function applyServerMsg(lines: CallLine[], msg: ServerMsg): CallLine[] {
  switch (msg.type) {
    case 'transcript': {
      const id = userId(msg.turn);
      const idx = lines.findIndex((l) => l.id === id);
      if (idx >= 0) {
        if (lines[idx].final) return lines;
        const next = lines.slice();
        next[idx] = { ...lines[idx], text: msg.text, final: msg.final };
        return next;
      }
      return [...lines, { id, role: 'user', text: msg.text, final: msg.final, turn: msg.turn }];
    }
    case 'transcript_retract': {
      let idx = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].role === 'user') {
          idx = i;
          break;
        }
      }
      if (idx < 0) return lines;
      return lines.filter((_, i) => i !== idx);
    }
    case 'text': {
      const id = assistantId(msg.turn);
      const idx = lines.findIndex((l) => l.id === id);
      if (idx >= 0) {
        const next = lines.slice();
        next[idx] = { ...lines[idx], text: lines[idx].text + msg.delta };
        return next;
      }
      return [...lines, { id, role: 'assistant', text: msg.delta, final: false, turn: msg.turn }];
    }
    case 'turn_end':
    case 'interrupted': {
      const id = assistantId(msg.turn);
      const idx = lines.findIndex((l) => l.id === id);
      if (idx < 0 || lines[idx].final) return lines;
      const next = lines.slice();
      next[idx] = { ...lines[idx], final: true };
      return next;
    }
    default:
      return lines;
  }
}

/** ユーザーがキーボードで送った文を、確定した user 行として足す(同じターンの行があれば置き換える)。 */
export function addUserText(lines: CallLine[], text: string, turn: number): CallLine[] {
  const id = userId(turn);
  const line: CallLine = { id, role: 'user', text, final: true, turn };
  const idx = lines.findIndex((l) => l.id === id);
  if (idx >= 0) {
    const next = lines.slice();
    next[idx] = line;
    return next;
  }
  return [...lines, line];
}
