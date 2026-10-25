// Pure helpers for the desktop pet's items (v2): one item per running or unread conversation. The main app
// builds them (desktopPet.ts), the pet window shows them (DesktopPetPage.tsx). See docs/design/V056-DESKTOP-PET.md.
import type { CodeStatus, Message } from './protocol';
import type { PetMode } from './petState';
import { bubbleFor, unreadBubbleText, type PetOutcome } from './petBubble';

export interface PetItem {
  id: string;
  title: string;
  mode: PetMode;
  label: string;
  detail: string;
  /** when the item started (running) or finished (unread / just finished); orders the items, newest first */
  at: number;
  unread: boolean;
}

/** At most this many items are sent (running first, then unread, then just finished). */
export const PET_MAX_ITEMS = 8;

/** Base activity of a conversation's streaming message: '' when nothing streams. */
export function liveActivity(msgs: Record<string, Message> | undefined): '' | 'searching' | 'running' | 'thinking' {
  if (!msgs) return '';
  for (const m of Object.values(msgs)) {
    if (m.role !== 'assistant' || m.status !== 'streaming') continue;
    const ph = m.phases || [];
    for (let i = ph.length - 1; i >= 0; i--) {
      if (ph[i].end == null) {
        const p = ph[i].phase;
        return p === 'searching' ? 'searching' : p === 'thinking' ? 'thinking' : 'running';
      }
    }
    return 'running';
  }
  return '';
}

/** Name of the running tool from the streaming message's open tool phase (empty when there is none). */
export function activeToolLabel(msgs: Record<string, Message> | undefined): string {
  if (!msgs) return '';
  for (const m of Object.values(msgs)) {
    if (m.role !== 'assistant' || m.status !== 'streaming') continue;
    const ph = m.phases || [];
    for (let i = ph.length - 1; i >= 0; i--) {
      if (ph[i].end == null) {
        return ph[i].phase === 'tool' ? (ph[i].label ?? '') : '';
      }
    }
    return '';
  }
  return '';
}

/**
 * Pet mode of one conversation, as the pet's own state machine reads it (approval first, then the streaming
 * phase, then a running code session). '' when the conversation is not running.
 */
export function activityOf(msgs: Record<string, Message> | undefined, codeStatus: CodeStatus | undefined): PetMode | '' {
  if (codeStatus === 'awaiting_approval') return 'waiting';
  const live = liveActivity(msgs);
  if (live) return live;
  if (codeStatus === 'running') return 'running';
  return '';
}

export interface RunInput { id: string; title: string; mode: PetMode; detail: string; at: number }
export interface FinishedInput { id: string; title: string; outcome: PetOutcome; at: number; unread: boolean }

/**
 * Items for the pet window. Running conversations come first; an unread finish is dropped when the same
 * conversation runs again. Capped at PET_MAX_ITEMS, returned newest first.
 */
export function buildItems(runs: RunInput[], finished: FinishedInput[], lang: string): PetItem[] {
  const running = new Set(runs.map((r) => r.id));
  const ranked: { rank: number; item: PetItem }[] = [];
  for (const r of runs) {
    ranked.push({
      rank: 0,
      item: { id: r.id, title: r.title, mode: r.mode, label: bubbleFor(r.mode, r.detail, lang)?.text ?? '', detail: r.detail, at: r.at, unread: false },
    });
  }
  for (const f of finished) {
    if (running.has(f.id)) continue;
    const mode: PetMode = f.outcome === 'error' ? 'failed' : 'jumping';
    ranked.push({
      rank: f.unread ? 1 : 2,
      item: {
        id: f.id,
        title: f.title,
        mode,
        label: f.unread ? unreadBubbleText(f.outcome, lang) : (bubbleFor(mode, '', lang)?.text ?? ''),
        detail: '',
        at: f.at,
        unread: f.unread,
      },
    });
  }
  ranked.sort((a, b) => a.rank - b.rank || b.item.at - a.item.at);
  return ranked
    .slice(0, PET_MAX_ITEMS)
    .map((x) => x.item)
    .sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
}

const MODES: PetMode[] = ['idle', 'thinking', 'running', 'searching', 'waiting', 'failed', 'jumping', 'waving'];

/**
 * Items from a message on the pet channel. v2 carries `items`; an older publisher sends one state
 * (`mode`, `label`) which becomes one item (or none when idle).
 */
export function itemsFromState(m: any): PetItem[] {
  if (!m || typeof m !== 'object') return [];
  if (Array.isArray(m.items)) {
    const out: PetItem[] = [];
    for (const it of m.items) {
      if (!it || typeof it.id !== 'string' || !MODES.includes(it.mode)) continue;
      out.push({
        id: it.id,
        title: typeof it.title === 'string' ? it.title : '',
        mode: it.mode,
        label: typeof it.label === 'string' ? it.label : '',
        detail: typeof it.detail === 'string' ? it.detail : '',
        at: typeof it.at === 'number' ? it.at : 0,
        unread: it.unread === true,
      });
    }
    return out;
  }
  if (!MODES.includes(m.mode) || m.mode === 'idle') return [];
  return [{ id: 'legacy', title: '', mode: m.mode, label: typeof m.label === 'string' ? m.label : '', detail: '', at: typeof m.at === 'number' ? m.at : 0, unread: false }];
}
