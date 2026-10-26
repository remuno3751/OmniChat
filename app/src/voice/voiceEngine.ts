// Aria 音声通話のネイティブ用の代替。この端末では通話できない(Web 版は voiceEngine.web.ts)。
// 型は web 版と同じ内容。設計: docs/design/ARIA-VOICE.md

import type { ServerMsg } from './ariaProtocol';

export type CallState = 'idle' | 'connecting' | 'ready' | 'closed' | 'error';

export interface CallEvents {
  onState(state: CallState, detail?: string): void;
  /** サーバーのメッセージ(ready 後の ttsModes などを画面が読む) */
  onMessage(msg: ServerMsg): void;
  /** マイクの音量 0..1(画面のメーター用。100 ms ごと程度) */
  onMicLevel(level: number): void;
  /** 返事の音声を再生中か */
  onSpeaking(speaking: boolean): void;
  /** 実際に使うコーデック(start 後、hello の前に一度)。Opus を望んで pcm16 に戻したときは fellBack=true */
  onCodec?(codec: 'pcm16' | 'opus', fellBack: boolean): void;
}

export interface CallOptions {
  /** full relay URL from buildRelayUrl() (voiceApi.ts): ws(s)://<server>/voice/ws?token=&conversationId= */
  url: string;
  settings: Record<string, number | string | boolean>;
  voice?: string;
  micEnabled: boolean;
  /** 望むコーデック(省略は pcm16)。Opus が使えない環境では pcm16 に戻る */
  codec?: 'pcm16' | 'opus';
}

export interface VoiceCall {
  /** 接続して hello を送る。マイクが使えないときも、文字だけで続ける(onState の detail に 'mic-denied') */
  start(): Promise<void>;
  sendText(text: string): void;
  /** {type:'interrupt'} を送り、再生を止める */
  interrupt(): void;
  updateSettings(values: Record<string, number | string | boolean>, persist: boolean): void;
  /** ミュート */
  setMicEnabled(on: boolean): void;
  /** 切断してマイクと再生を止める。何度呼んでもよい */
  stop(): void;
}

/** この端末で通話できるか(web: true、native: false) */
export const supported: boolean = false;

export function createCall(_opts: CallOptions, events: CallEvents): VoiceCall {
  return {
    async start(): Promise<void> {
      events.onState('error', 'unsupported');
    },
    sendText(): void {},
    interrupt(): void {},
    updateSettings(): void {},
    setMicEnabled(): void {},
    stop(): void {},
  };
}
