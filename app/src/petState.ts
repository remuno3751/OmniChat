import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import type { Message } from './protocol';
import { onNotify } from './v4Events';

/** Animation state of the pet. Each name maps to one sprite row (see PET_ROW_FOR_MODE). */
export type PetMode = 'idle' | 'running' | 'searching' | 'waiting' | 'failed' | 'jumping' | 'waving';

/**
 * Frame durations (ms) per sprite row, one entry per frame (PROTOCOL-v4 section 9).
 * Rows 1/2 (walking) and 9/10 (v2 look directions) are not used by the state machine.
 */
const rep = (n: number, ms: number): number[] => Array<number>(n).fill(ms);
export const PET_ROWS: Record<number, number[]> = {
  0: [280, 110, 110, 140, 140, 320],
  1: [...rep(7, 120), 220],
  2: [...rep(7, 120), 220],
  3: [140, 140, 140, 280],
  4: [140, 140, 140, 140, 280],
  5: [...rep(7, 140), 240],
  6: [...rep(5, 150), 260],
  7: [...rep(5, 120), 220],
  8: [...rep(5, 150), 280],
};

/** Sprite row shown for each pet mode. */
export const PET_ROW_FOR_MODE: Record<PetMode, number> = {
  idle: 0,
  running: 7,
  searching: 8,
  waiting: 6,
  failed: 5,
  jumping: 4,
  waving: 3,
};

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
/** One full cycle of the jumping row, then one full cycle of the waving row. */
const JUMP_MS = sum(PET_ROWS[4]);
const WAVE_MS = sum(PET_ROWS[3]);
const WAITING_TIMEOUT_MS = 30_000;
const FAILED_MS = 4_000;

type Transient = { mode: 'waiting' | 'failed' | 'jumping' | 'waving'; seq: number } | null;

/**
 * Base activity of the conversation: '' when nothing streams, otherwise 'searching' when the
 * streaming assistant message has an open searching phase, else 'running'.
 * Returns a primitive so the selector does not re-render on every streamed token.
 */
function liveActivity(msgs: Record<string, Message> | undefined): '' | 'searching' | 'running' {
  if (!msgs) return '';
  for (const m of Object.values(msgs)) {
    if (m.role !== 'assistant' || m.status !== 'streaming') continue;
    const ph = m.phases || [];
    for (let i = ph.length - 1; i >= 0; i--) {
      if (ph[i].end == null) return ph[i].phase === 'searching' ? 'searching' : 'running';
    }
    return 'running';
  }
  return '';
}

/**
 * Pet mode for the active conversation.
 *
 * Base (from state): awaiting_approval -> waiting; streaming (searching phase -> searching, else running);
 * codeStatus running -> running; codeStatus error -> failed; otherwise idle.
 * Transient (from WS notify frames for this conversation) overrides the base:
 *  - approval -> waiting until codeStatus/streaming changes or 30 s
 *  - error -> failed for 4 s
 *  - done -> jumping (one cycle), then waving (one cycle), then back to the base state
 */
export function usePetMode(activeConvId: string | null | undefined): PetMode {
  const convId = activeConvId ?? '';
  const live = useStore((s) => (convId ? liveActivity(s.messages[convId]) : ''));
  const codeStatus = useStore((s) => (convId ? s.conversations[convId]?.codeStatus : undefined));
  const [transient, setTransient] = useState<Transient>(null);
  const seqRef = useRef(0);

  // A different conversation never inherits the previous one's transient state.
  useEffect(() => {
    setTransient(null);
  }, [convId]);

  // Notify frames for this conversation drive the transient states.
  useEffect(() => {
    if (!convId) return;
    return onNotify((f) => {
      if (f.conversationId !== convId) return;
      const seq = ++seqRef.current;
      if (f.kind === 'approval') setTransient({ mode: 'waiting', seq });
      else if (f.kind === 'error') setTransient({ mode: 'failed', seq });
      else setTransient({ mode: 'jumping', seq });
    });
  }, [convId]);

  // A waiting-for-approval state ends as soon as the run's status or streaming state changes.
  const sig = `${codeStatus ?? ''}|${live}`;
  useEffect(() => {
    setTransient((t) => (t?.mode === 'waiting' ? null : t));
  }, [sig]);

  // Timers for the transient states; cleared on every change of the transient and on unmount.
  useEffect(() => {
    if (!transient) return;
    const { mode } = transient;
    const ms = mode === 'waiting' ? WAITING_TIMEOUT_MS
      : mode === 'failed' ? FAILED_MS
      : mode === 'jumping' ? JUMP_MS
      : WAVE_MS;
    const id = setTimeout(() => {
      if (mode === 'jumping') setTransient({ mode: 'waving', seq: ++seqRef.current });
      else setTransient(null);
    }, ms);
    return () => clearTimeout(id);
  }, [transient]);

  if (transient) return transient.mode;
  if (codeStatus === 'awaiting_approval') return 'waiting';
  if (live) return live;
  if (codeStatus === 'running') return 'running';
  if (codeStatus === 'error') return 'failed';
  return 'idle';
}
