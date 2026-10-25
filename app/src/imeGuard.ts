/* IME guard for the composer's Enter-to-send (web). Pure: the caller feeds the DOM events in order. */

/** An Enter keydown this soon after a compositionend is the key that confirmed the conversion. */
export const IME_ENTER_WINDOW_MS = 30;

/** endAt: time of the compositionend not yet consumed by a keydown or keyup; null = none. */
export interface ImeState { endAt: number | null }

export const initialImeState = (): ImeState => ({ endAt: null });

/** The fields of a keydown that the decision reads, plus the time it arrived (ms). */
export interface ImeKeyEvent {
  key?: string;
  keyCode?: number;
  isComposing?: boolean;
  repeat?: boolean;
  time: number;
}

/** Next state after an event: a compositionend records its time; a keydown or keyup consumes it. */
export function imeAfter(state: ImeState, type: 'compositionend' | 'keydown' | 'keyup', time: number): ImeState {
  if (type === 'compositionend') return { endAt: time };
  return state.endAt === null ? state : { endAt: null };
}

/**
 * True when this keydown must not send (and must not be treated as Enter-to-send):
 * composing text, the IME's process key (keyCode 229), or the first Enter right after a compositionend.
 * A held key (repeat) is not swallowed here; the caller ignores repeats for the send action itself.
 */
export function shouldSwallowEnter(state: ImeState, ev: ImeKeyEvent): boolean {
  if (ev.isComposing) return true;
  if (ev.keyCode === 229 && (ev.key === 'Process' || ev.key === 'Unidentified' || ev.isComposing)) return true;
  if (ev.key !== 'Enter' || state.endAt === null) return false;
  const d = ev.time - state.endAt;
  return d >= 0 && d <= IME_ENTER_WINDOW_MS;
}
