// Pure logic of the Aria voice call bar: reconnect timing, close reasons, push-to-talk keys.
// No React / react-native / browser APIs, so the node tests can load it (see __tests__/callLogic.test.ts).

import { CLOSE_BUSY, CLOSE_VOICE_OFF, RECONNECT_MAX_AUTO, RECONNECT_MIN_MS } from './voiceApi';

/** ms to wait before the next attempt is allowed (0 = now). Used by the reconnect button and the automatic retry. */
export function manualReconnectWait(now: number, lastAttemptAt: number | null): number {
  if (lastAttemptAt === null) return 0;
  return Math.max(0, lastAttemptAt + RECONNECT_MIN_MS - now);
}

/** Delay before an automatic retry, or null when no more automatic retries are allowed (autoCount reached the cap). */
export function nextReconnectDelay(now: number, lastAttemptAt: number | null, autoCount: number): number | null {
  if (autoCount >= RECONNECT_MAX_AUTO) return null;
  return manualReconnectWait(now, lastAttemptAt);
}

export interface CloseInfo {
  code?: number;
  /** sanitized reason text (see sanitizeReason) */
  reason?: string;
}

/** Reasons after which the call must not come back by itself (the server means "do not retry"). */
const TERMINAL_REASONS = ['voice_off', 'busy', 'quota'];

/** Automatic retry only for an unexpected close: not for 4409 (voice off), 4429 (busy or quota), or a terminal reason. */
export function shouldAutoReconnect(info: CloseInfo): boolean {
  if (info.code === CLOSE_VOICE_OFF || info.code === CLOSE_BUSY) return false;
  return !(info.reason !== undefined && TERMINAL_REASONS.includes(info.reason));
}

/** Error to show for a close with a code: 4409 = voice off, 4429 = quota (with reason 'quota') or busy. */
export function closeErrorOf(info: CloseInfo): 'off' | 'busy' | 'quota' | null {
  if (info.code === CLOSE_VOICE_OFF) return 'off';
  if (info.code === CLOSE_BUSY) return info.reason === 'quota' ? 'quota' : 'busy';
  return null;
}

/** Lower case, only a-z 0-9 _ space -, at most 60 characters. An empty string when nothing is left. */
export function sanitizeReason(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_ -]/g, '').trim().slice(0, 60).trim();
}

/**
 * The detail the web engine passes with onState('closed'): 'code:<n>' for 4409 / 4429, and 'reason:<text>' for a
 * sanitized reason, joined with ';' (e.g. 'code:4429;reason:quota'). undefined when there is nothing to say.
 */
export function closeDetail(code: number | undefined, reason: string | undefined): string | undefined {
  const parts: string[] = [];
  if (code === CLOSE_VOICE_OFF || code === CLOSE_BUSY) parts.push(`code:${code}`);
  const r = sanitizeReason(reason ?? '');
  if (r) parts.push(`reason:${r}`);
  return parts.length ? parts.join(';') : undefined;
}

/** Reverse of closeDetail. Unknown parts are dropped. */
export function parseCloseDetail(detail: string | undefined): CloseInfo {
  const info: CloseInfo = {};
  if (!detail) return info;
  for (const part of detail.split(';')) {
    if (part.startsWith('code:')) {
      const n = Number(part.slice(5));
      if (Number.isInteger(n)) info.code = n;
    } else if (part.startsWith('reason:')) {
      const r = sanitizeReason(part.slice(7));
      if (r) info.reason = r;
    }
  }
  return info;
}

/** The i18n key for a close reason; a reason that is not known (or none) gets the generic text. */
export function closeReasonKey(reason: string | null | undefined): string {
  switch (reason) {
    case 'aria_restarting':
      return 'host.call.reason.aria_restarting';
    case 'voice_off':
      return 'host.call.reason.voice_off';
    case 'busy':
      return 'host.call.reason.busy';
    case 'quota':
      return 'host.call.reason.quota';
    default:
      return 'host.call.reason.generic';
  }
}

/** The focused element is a text field, so the space key belongs to the text (no push-to-talk). */
export function isTypingTarget(el: { tagName?: string; isContentEditable?: boolean } | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
