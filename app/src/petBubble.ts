// Speech bubble text for the pet (pure). The text comes from the i18n tables (v056fStrings.ts); the
// desktop pet window and the in-app overlay use the same mapping. See docs/design/V056-DESKTOP-PET.md.
import type { PetMode } from './petState';
import { translate } from './i18n/index';

export interface PetBubble {
  text: string;
  /** How long the bubble stays after it appears; null = until the state changes. */
  ttlMs: number | null;
}

export const DONE_TTL_MS = 4000;
export const ERROR_TTL_MS = 6000;
/** How a run ended, for the pet's unread bubbles. */
export type PetOutcome = 'done' | 'error';

/** Text of an unread bubble (a finished run the user has not looked at yet). */
export function unreadBubbleText(outcome: PetOutcome, lang: string): string {
  return translate(lang, outcome === 'error' ? 'pets.unread.error' : 'pets.unread.done');
}

/** Title shown under a bubble: the chat's title, trimmed, or a placeholder when it has none. */
export function itemTitle(title: string, lang: string): string {
  const t = (title || '').trim();
  return t || translate(lang, 'pets.item.untitled');
}

/** Longest tool name shown in the bubble (the rest is cut with an ellipsis). */
export const TOOL_NAME_MAX = 24;

/** Shortens a tool name to at most TOOL_NAME_MAX characters, adding an ellipsis when cut. */
export function clipToolName(name: string): string {
  const s = name.trim();
  return s.length > TOOL_NAME_MAX ? `${s.slice(0, TOOL_NAME_MAX - 1)}…` : s;
}

/**
 * Bubble for a pet mode. `detail` is the running tool's name (may be empty). `lang` is the resolved
 * language ('ja' or 'en'). Returns null for idle (no bubble).
 */
export function bubbleFor(mode: PetMode, detail: string, lang: string): PetBubble | null {
  const tr = (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars);
  switch (mode) {
    case 'idle':
      return null;
    case 'thinking':
      return { text: tr('pets.bubble.thinking'), ttlMs: null };
    case 'running': {
      const tool = clipToolName(detail);
      return { text: tool ? tr('pets.bubble.tool', { tool }) : tr('pets.bubble.writing'), ttlMs: null };
    }
    case 'searching': {
      const tool = clipToolName(detail);
      return { text: tool ? tr('pets.bubble.tool', { tool }) : tr('pets.bubble.searching'), ttlMs: null };
    }
    case 'waiting':
      return { text: tr('pets.bubble.waiting'), ttlMs: null };
    case 'jumping':
    case 'waving':
      return { text: tr('pets.bubble.done'), ttlMs: DONE_TTL_MS };
    case 'failed':
      return { text: tr('pets.bubble.error'), ttlMs: ERROR_TTL_MS };
  }
}

/** Time-to-live for a mode's bubble without a language (the TTL does not depend on the text). */
export function bubbleTtl(mode: PetMode): number | null {
  if (mode === 'jumping' || mode === 'waving') return DONE_TTL_MS;
  if (mode === 'failed') return ERROR_TTL_MS;
  return null;
}
