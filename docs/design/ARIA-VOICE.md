# Aria 音声通話(アプリ側)の設計と契約

Aria(別プロジェクトの AI-VTuber)の音声通話サーバーに、OmniChat のアプリが直接つないで会話する機能です。
サーバー側の取り決めは Aria 側の `docs/current/OMNICHAT_VOICE_CONTRACT.md`(正)。ここは、アプリ側の作りとモジュール間の約束です。

## 決定事項(ユーザー承認済み、2026-10-26)
- アプリが Aria の `wss://<aria>/live/ws` に**直接**つなぐ(OmniChat サーバーは中継しない)。tailnet の中だけ。
- 範囲: 通話画面 + 話し方の設定。音声は **PCM16 のみ**(送信 16 kHz モノラル、受信は `hello` に `codec:"pcm16"`)。Opus は後。
- モデルの切り替えと声モデルの管理(admin)は、アプリに置かない。admin トークンは扱わない。
- 通話の記録は Aria 側だけ。OmniChat の会話履歴には書かない。
- 対応する端末: **Web とデスクトップ(Windows / Mac。どちらも Web 版の画面)**。Android(ネイティブ)は、マイクのストリーム取り込みに別のネイティブ実装が要るため、今回は「未対応」と画面に出す。

## ファイル構成
| ファイル | 役目 |
|---|---|
| `app/src/voice/ariaProtocol.ts` | 純粋なロジック(React / ブラウザ API を import しない)。型、URL、設定の範囲、音声の変換、ターンの管理、文字起こしの表示モデル |
| `app/src/__tests__/ariaProtocol.test.ts` | 上の単体テスト(node:test) |
| `app/src/voice/voiceEngine.ts` | ネイティブ用の代替(`supported = false` を返すだけ) |
| `app/src/voice/voiceEngine.web.ts` | Web 用の実装: WebSocket、マイク、再生、割り込み |
| `app/src/screens/VoiceCallScreen.tsx` | 通話画面 |
| `app/src/screens/settings/VoicePage.tsx` | 設定ページ「音声通話」(接続先、話し方、通話を始めるボタン) |
| `app/src/i18n/voiceStrings.ts` | 日本語と英語の文言(`ja` と `en` を export し、`i18n/ja.ts` / `en.ts` にマージ) |
| `app/src/deviceSettings.ts` | `voice` 設定を追加(下記) |
| `app/src/settingsMeta.ts` | `SettingsPageId` に `'voice'` を追加し、設定の項目を登録 |

## 端末ごとの設定(`deviceSettings.voice`)
```ts
export interface VoiceSettings {
  /** Aria の URL。http(s):// または ws(s):// で始まる。空 = 未設定 */
  url: string;
  /** 履歴と話し方の保存先(?user=)。既定 'default' */
  user: string;
  /** chat スコープのトークン。ループバックなら空でよい */
  token: string;
  /** hello に入れる声(話者/スタイル ID)。空 = サーバーの既定 */
  voice: string;
  ttsMode: 'balanced' | 'fast';
  speed: number;          // 0.5 – 2.0, 既定 1
  pauseScale: number;     // 0 – 2, 既定 1
  responseDelayMs: number;// 0 – 3000, 既定 0
  endOfTurnMs: number;    // 200 – 3000, 既定 350
  bargeIn: boolean;       // 既定 true
  bargeInDb: number;      // 割り込み感度(dB)。既定 -35、範囲 -70 – -10
}
```
`normalizeDevice` は、壊れた値・欠けた値を既定値と範囲に丸める。`DevicePatch` は `voice?: Partial<VoiceSettings>`(`dsh` と同じ入れ子の更新)。

## `ariaProtocol.ts` の公開 API(これを実装する)
```ts
export const ARIA_SAMPLE_RATE_IN = 16000;
export type TtsMode = 'balanced' | 'fast';

/** クライアント → サーバーの JSON */
export type ClientMsg =
  | { type: 'hello'; codec: 'pcm16'; voice?: string; settings?: Record<string, number | string | boolean> }
  | { type: 'settings'; values: Record<string, number | string | boolean>; persist?: boolean }
  | { type: 'text'; text: string }
  | { type: 'interrupt' }
  | { type: 'ping' };

/** サーバー → クライアントの JSON(未知の type は 'unknown' にして捨てない) */
export type ServerMsg =
  | { type: 'ready'; codec: string; sampleRate: number; session?: string; settings?: Record<string, unknown>; ttsModes: string[] }
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
  | { type: 'unknown'; raw: unknown };

/** 入力の URL(http/https/ws/wss)を wss/ws の /live/ws に直し、?user= と ?token= を付ける。不正なら null。http → ws、https → wss。末尾のパスは /live/ws に置き換える */
export function buildLiveUrl(base: string, user: string, token: string): string | null;
/** JSON 文字列を ServerMsg にする。JSON でない・type が無いときは null。ready の codec / sample_rate / tts_modes は camelCase に直す(sampleRate, ttsModes) */
export function parseServerMessage(text: string): ServerMsg | null;

/** 設定を契約書の範囲に丸める(未知のキーは捨てる)。キーは Aria 側の名前(snake_case): speed, pitch, intonation, volume, pause_scale, tempo_dynamics, pre_ms, post_ms, response_delay_ms, end_of_turn_ms, barge_in, barge_in_min_ms, barge_in_db, voice, tts_mode */
export function clampAriaSettings(values: Record<string, unknown>): Record<string, number | string | boolean>;
/** アプリの VoiceSettings から、hello / settings に載せる値を作る */
export function settingsFromVoice(v: { voice: string; ttsMode: TtsMode; speed: number; pauseScale: number; responseDelayMs: number; endOfTurnMs: number; bargeIn: boolean; bargeInDb: number }): Record<string, number | string | boolean>;

/** 音声の変換 */
export function downsampleTo16k(input: Float32Array, inRate: number): Float32Array; // inRate が 16000 ならそのまま返す。平均で間引く
export function floatToPcm16(input: Float32Array): Int16Array;                      // -1..1 に丸めてから ×32767
export function pcm16ToFloat(data: ArrayBuffer | Int16Array): Float32Array;         // リトルエンディアン
export function pcmChunkDurationSec(byteLength: number, sampleRate: number): number; // モノラル 16 bit

/** ターンの管理: 古いターンの音声を捨てる、seq 順に並べる */
export class TurnGate {
  /** turn_start / audio / text / transcript で現在のターンを更新する。新しい turn が来たら、前のターンの保留分を捨てる */
  start(turn: number): void;
  interrupt(turn?: number): void;           // interrupted: そのターンを終わりにして、以降の同じターンの音声を捨てる
  accept(turn: number): boolean;            // このターンのデータを受けてよいか(現在のターン以降 かつ 中断されていない)
  readonly current: number;
}

/** 通話の表示用の行 */
export interface CallLine { id: string; role: 'user' | 'assistant'; text: string; final: boolean; turn: number }
/** 文字起こしの reducer。transcript(final=false) は同じ user 行を更新、final=true で確定。transcript_retract は最後の未確定でない user 行ではなく、最後の user 行(直近のもの)を取り消す。text は assistant 行に delta を足す。interrupted は assistant 行を final にする */
export function applyServerMsg(lines: CallLine[], msg: ServerMsg): CallLine[];
/** ユーザーがキーボードで送った文を、確定した user 行として足す */
export function addUserText(lines: CallLine[], text: string, turn: number): CallLine[];
```

## `voiceEngine` の公開 API(web 版と native 版で同じ形)
```ts
export type CallState = 'idle' | 'connecting' | 'ready' | 'closed' | 'error';
export interface CallEvents {
  onState(state: CallState, detail?: string): void;
  /** サーバーのメッセージ(ready 後の ttsModes などを画面が読む) */
  onMessage(msg: ServerMsg): void;
  /** マイクの音量 0..1(画面のメーター用。100 ms ごと程度) */
  onMicLevel(level: number): void;
  /** 返事の音声を再生中か */
  onSpeaking(speaking: boolean): void;
}
export interface CallOptions { url: string; user: string; token: string; settings: Record<string, number | string | boolean>; voice?: string; micEnabled: boolean }
export interface VoiceCall {
  start(): Promise<void>;                 // 接続して hello を送る。マイクが使えないときも、文字だけで続ける(onState の detail に 'mic-denied')
  sendText(text: string): void;
  interrupt(): void;                      // {type:'interrupt'} を送り、再生を止める
  updateSettings(values: Record<string, number | string | boolean>, persist: boolean): void;
  setMicEnabled(on: boolean): void;       // ミュート
  stop(): void;                           // 切断してマイクと再生を止める。何度呼んでもよい
}
export const supported: boolean;          // この端末で通話できるか(web: true、native: false)
export function createCall(opts: CallOptions, events: CallEvents): VoiceCall;
```
- マイクは `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })`。
- 取り込みは AudioWorklet(Blob の URL から読み込む)。使えない環境は ScriptProcessor に落とす。20〜100 ms ごとに、`downsampleTo16k` → `floatToPcm16` → WebSocket のバイナリで送る。
- 受信の `audio` の次に来る `frames` 個のバイナリを、その `audio` の音声として、`sampleRate` の PCM16 モノラルで再生する(AudioContext のスケジュールで途切れなく続ける)。`TurnGate` で、古いターン・中断されたターンの音声は捨てる。
- 割り込み(`interrupt()`、または `interrupted` の受信)で、再生中の音を即座に止める。
- 切断時は、必ずマイクのトラックと AudioContext を閉じる。

## 画面
- 設定 → 「音声通話」ページ(`VoicePage`): 接続先(URL、ユーザー名、トークン。トークンは伏せ字)、話し方(声のモード、速さ、間、会話の間、割り込み)、「通話を始める」。URL が空なら始められない。
- 通話画面(`VoiceCallScreen`): 状態(接続中 / 通話中 / 切れた)、マイクのメーター、ミュート、割り込み、終了、文字の表示(`CallLine`)、キーボード入力。ネイティブ(`supported=false`)は「この端末では未対応です(Web 版とデスクトップ版で使えます)」を出す。
- 設定の変更は、通話中なら `updateSettings(values, true)` で即反映する。

## 検証
- 擬似の Aria サーバー(`/live/ws`、`ready` → `text` → `audio`+バイナリ → `turn_end`、`interrupt`、`settings`)を Node で書いて、Web 版のアプリで、文字入力 → 返事の音声の再生まで通す。
- マイクは、実機のマイクがないと確認できない。確認していない項目は、リリースノートに書く。
