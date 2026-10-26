/**
 * Thin layer over the OmniChat server's /voice/* API (docs/design/ARIA-HOST.md). The app talks only to the OmniChat
 * server; the device token goes into the Authorization header (REST) or `?token=` (WS) and never into logs / errors.
 */
import { AriaHttpError, ariaFetchJson } from './ariaRest';
import type { VoiceModel } from './ariaVoices';

export { AriaHttpError as VoiceApiError };

export type VoiceMode = 'off' | 'hosted' | 'external';
export type TtsMode = 'balanced' | 'fast';
export interface VoiceUserPrefs {
  voice?: string;
  ttsMode?: TtsMode;
  speed?: number;
  pauseScale?: number;
  responseDelayMs?: number;
  endOfTurnMs?: number;
  bargeIn?: boolean;
  bargeInDb?: number;
}

export interface VoiceStatus {
  mode: VoiceMode;
  ready: boolean;
  ttsModes: string[];
  me: VoiceUserPrefs & { effective?: VoiceUserPrefs };
  canAdmin: boolean;
}

/** balanced reads at 1.3 unless the user chose a speed; fast at 1.0 (ARIA-HOST.md "VoiceUserPrefs"). */
export function defaultSpeed(mode: TtsMode | undefined): number {
  return mode === 'fast' ? 1 : 1.3;
}
export function effectiveSpeed(p: VoiceUserPrefs | undefined): number {
  return typeof p?.speed === 'number' ? p.speed : defaultSpeed(p?.ttsMode);
}

/** One server voice model: Aria's entry plus the owner info the OmniChat server adds. */
/** kind: 'aivmx' (balanced / AivisSpeech) or 'piper' (fast / piper-plus); builtin = cannot be deleted (e.g. tsukuyomi) */
export type VoiceKind = 'aivmx' | 'piper';
export type ServerVoiceModel = VoiceModel & { ownerUserId?: string; mine: boolean; kind?: VoiceKind; builtin?: boolean };

export interface VoiceApiCtx {
  /** the OmniChat server's base URL and the device token (api.getServerUrl() / api.getToken()) */
  base: string;
  token: string | null;
  /** injected in tests */
  fetchImpl?: typeof fetch;
}

const opts = (c: VoiceApiCtx, extra: Record<string, unknown> = {}) => ({ token: c.token ?? undefined, fetchImpl: c.fetchImpl, ...extra });

export const getStatus = (c: VoiceApiCtx) => ariaFetchJson<VoiceStatus>(c.base, '/voice/status', opts(c));
export const getMe = (c: VoiceApiCtx) => ariaFetchJson<VoiceUserPrefs>(c.base, '/voice/me', opts(c));
export const putMe = (c: VoiceApiCtx, prefs: VoiceUserPrefs) =>
  ariaFetchJson<VoiceUserPrefs>(c.base, '/voice/me', opts(c, { method: 'PUT', body: prefs }));
export const listVoices = (c: VoiceApiCtx) => ariaFetchJson<unknown>(c.base, '/voice/voices', opts(c));
export const deleteVoiceModel = (c: VoiceApiCtx, uuid: string) =>
  ariaFetchJson<unknown>(c.base, `/voice/voices/models/${encodeURIComponent(uuid)}`, opts(c, { method: 'DELETE' }));
/** Small-file upload through fetch; the card uses voiceModelUploadUrl + XHR for progress. */
export const uploadVoiceModel = (c: VoiceApiCtx, name: string, body: Blob | ArrayBuffer | Uint8Array, signal?: AbortSignal) =>
  ariaFetchJson<unknown>(c.base, voiceModelUploadPath(name), opts(c, { method: 'POST', body, contentType: 'application/octet-stream', timeoutMs: 10 * 60 * 1000, signal }));

export const voiceModelUploadPath = (name: string) => `/voice/voices/models?name=${encodeURIComponent(name)}`;
/** piper (fast): `file` says what the raw body is: a zip holding model + config, the .onnx, or its config.json. `id`: [a-z0-9_-]{1,40} */
export const piperUploadPath = (id: string, file: 'zip' | 'model' | 'config') =>
  `/voice/voices/models?kind=piper&name=${encodeURIComponent(id)}&file=${file}`;
export const PIPER_ID_RE = /^[a-z0-9_-]{1,40}$/;

/** 422 from a piper upload: not a piper-plus ONNX (e.g. a plain SBV2 ONNX) */
export const isUnprocessable = (e: unknown): boolean => e instanceof AriaHttpError && e.status === 422;
/** 501 not_supported_yet: the Aria side does not offer this yet */
export const isNotSupportedYet = (e: unknown): boolean => e instanceof AriaHttpError && (e.code === 'not_supported_yet' || e.status === 501);

export interface DiagnoseItem { id: string; ok: boolean; message: string; hint?: string }
export const getDiagnose = (c: VoiceApiCtx) => ariaFetchJson<DiagnoseItem[]>(c.base, '/voice/diagnose', opts(c));
export interface VoiceUsage { callSeconds: number; turns: number }
/** my usage (today and total are optional; the server may send only some of them) */
export const getUsage = (c: VoiceApiCtx) => ariaFetchJson<VoiceUsage & { today?: VoiceUsage }>(c.base, '/voice/usage', opts(c));

/** Sample reading (POST /voice/preview): returns the WAV bytes (audio/wav). Errors as for the other calls (501 not_supported_yet). */
export async function previewVoice(c: VoiceApiCtx, body: { text?: string; voice?: string; ttsMode?: TtsMode }): Promise<ArrayBuffer> {
  const f = c.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${c.base}/voice/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(c.token ? { authorization: `Bearer ${c.token}` } : {}) },
      body: JSON.stringify(body),
    });
  } catch { throw new AriaHttpError(0, 'network'); }
  if (!res.ok) {
    let code: string | undefined; let msg = `HTTP ${res.status}`;
    try { const j: any = await res.json(); if (typeof j?.code === 'string') code = j.code; const m = j?.message ?? j?.error; if (typeof m === 'string') msg = m.slice(0, 300); } catch { /* not JSON */ }
    throw new AriaHttpError(res.status, msg, code);
  }
  return res.arrayBuffer();
}

/** `unsupported_format` (415) from POST /voice/voices/models */
export const isUnsupportedFormat = (e: unknown): boolean => e instanceof AriaHttpError && (e.code === 'unsupported_format' || e.status === 415);
/** the server cannot reach Aria (502 aria_unreachable) */
export const isAriaUnreachable = (e: unknown): boolean => e instanceof AriaHttpError && (e.code === 'aria_unreachable' || e.status === 502);
/** mode is off (409 voice_off) */
export const isVoiceOff = (e: unknown): boolean => e instanceof AriaHttpError && (e.code === 'voice_off' || e.status === 409);

/** ws(s)://<server>/voice/ws?token=&conversationId= ; null when the server URL or token is missing. */
export function buildRelayUrl(serverUrl: string, token: string | null, conversationId?: string, priv?: boolean): string | null {
  const raw = (serverUrl ?? '').trim();
  if (!raw || !token) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (!u.hostname) return null;
  if (u.protocol === 'http:' || u.protocol === 'ws:') u.protocol = 'ws:';
  else if (u.protocol === 'https:' || u.protocol === 'wss:') u.protocol = 'wss:';
  else return null;
  u.pathname = '/voice/ws';
  u.hash = '';
  const p = new URLSearchParams();
  p.set('token', token);
  if (conversationId) p.set('conversationId', conversationId);
  if (priv) p.set('private', '1');
  u.search = p.toString();
  return u.toString();
}

/** WS close codes the server uses (ARIA-HOST.md "中継の規則") */
export const CLOSE_VOICE_OFF = 4409;
export const CLOSE_BUSY = 4429;
/** minimum gap between reconnects, and the cap of automatic ones (ARIA-HOST-ADDENDUM / peer note) */
export const RECONNECT_MIN_MS = 3000;
export const RECONNECT_MAX_AUTO = 3;
