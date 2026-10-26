// Aria 音声通話の Opus 変換(WebCodecs)。Web 専用。純粋な計算は ./ariaProtocol にある。
// 受信: バイナリ 1 つ = 20 ms の Opus パケット(48 kHz、モノラル)。送信: 16 kHz か 48 kHz の 20 ms フレーム。

import { OPUS_FRAME_MS, OPUS_RECV_RATE } from './ariaProtocol';

const BITRATE = 32000;
const FRAME_US = OPUS_FRAME_MS * 1000;

type Anyish = any;
const g = (): Anyish => globalThis as Anyish;

/** WebCodecs の Opus が、受信 48 kHz と送信 sendRate の両方で使えるか */
export async function opusSupported(sendRate: number): Promise<boolean> {
  const G = g();
  if (typeof G.AudioDecoder === 'undefined' || typeof G.AudioEncoder === 'undefined') return false;
  if (typeof G.EncodedAudioChunk === 'undefined' || typeof G.AudioData === 'undefined') return false;
  try {
    const d = await G.AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: OPUS_RECV_RATE, numberOfChannels: 1 });
    const e = await G.AudioEncoder.isConfigSupported(encoderConfig(sendRate));
    return !!d?.supported && !!e?.supported;
  } catch {
    return false;
  }
}

function encoderConfig(rate: number): Anyish {
  return {
    codec: 'opus',
    sampleRate: rate,
    numberOfChannels: 1,
    bitrate: BITRATE,
    opus: { frameDuration: FRAME_US, application: 'voip' },
  };
}

export interface OpusDecoderHandle {
  /** 1 パケットを渡す。turn は、出力が出たときの捨て判定に使う */
  decode(packet: ArrayBuffer, turn: number): void;
  /** 溜まっている分を捨てる(割り込み) */
  flush(): void;
  close(): void;
}

/** 出力は 48 kHz モノラルの Float32 */
export function createOpusDecoder(
  onPcm: (samples: Float32Array, turn: number) => void,
  onError: () => void,
): OpusDecoderHandle {
  const G = g();
  const turns = new Map<number, number>();
  let counter = 0;
  let closed = false;

  const make = (): Anyish => {
    const dec = new G.AudioDecoder({
      output: (data: Anyish) => {
        try {
          const turn = turns.get(data.timestamp);
          turns.delete(data.timestamp);
          const out = new Float32Array(data.numberOfFrames);
          data.copyTo(out, { planeIndex: 0, format: 'f32-planar' });
          if (!closed && turn !== undefined) onPcm(out, turn);
        } finally {
          data.close();
        }
      },
      error: () => {
        if (!closed) onError();
      },
    });
    dec.configure({ codec: 'opus', sampleRate: OPUS_RECV_RATE, numberOfChannels: 1 });
    return dec;
  };
  let dec = make();

  return {
    decode(packet, turn) {
      if (closed) return;
      const ts = counter++ * FRAME_US;
      turns.set(ts, turn);
      try {
        dec.decode(new G.EncodedAudioChunk({ type: 'key', timestamp: ts, data: packet }));
      } catch {
        onError();
      }
    },
    flush() {
      if (closed) return;
      turns.clear();
      try {
        dec.close();
      } catch {
        // すでに閉じている
      }
      try {
        dec = make();
      } catch {
        onError();
      }
    },
    close() {
      closed = true;
      turns.clear();
      try {
        dec.close();
      } catch {
        // すでに閉じている
      }
    },
  };
}

export interface OpusEncoderHandle {
  /** ちょうど 20 ms 分(rate × 0.02 サンプル)のフレームを渡す */
  encode(frame: Float32Array): void;
  close(): void;
}

export function createOpusEncoder(
  rate: number,
  onPacket: (packet: ArrayBuffer) => void,
  onError: () => void,
): OpusEncoderHandle {
  const G = g();
  let closed = false;
  let counter = 0;
  const enc = new G.AudioEncoder({
    output: (chunk: Anyish) => {
      if (closed) return;
      const buf = new ArrayBuffer(chunk.byteLength);
      chunk.copyTo(buf);
      onPacket(buf);
    },
    error: () => {
      if (!closed) onError();
    },
  });
  enc.configure(encoderConfig(rate));
  return {
    encode(frame) {
      if (closed) return;
      try {
        const data = new G.AudioData({
          format: 'f32',
          sampleRate: rate,
          numberOfFrames: frame.length,
          numberOfChannels: 1,
          timestamp: counter++ * FRAME_US,
          data: frame,
        });
        enc.encode(data);
        data.close();
      } catch {
        onError();
      }
    },
    close() {
      closed = true;
      try {
        enc.close();
      } catch {
        // すでに閉じている
      }
    },
  };
}
