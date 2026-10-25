// Native (touch) pet gestures: a long press (450 ms) enters move mode; a short tap waves; a finger that
// moves more than 8 px before the long press cancels it (the touch is a scroll). Pure, no React Native.
// See docs/design/V056-DESKTOP-PET.md, "Android (touch) long-press move".

export const LONG_PRESS_MS = 450;
export const CANCEL_MOVE_PX = 8;

export type PetTouchPhase = 'idle' | 'pressing' | 'moving';

/** `dx`/`dy` are the cumulative finger offset since the touch started (PanResponder's gestureState). */
export type PetTouchEvent =
  | { type: 'down' }
  | { type: 'move'; dx: number; dy: number }
  | { type: 'longPress' }
  | { type: 'up' }
  | { type: 'terminate' };

/**
 * What the caller must do after a transition:
 * - vibrate: move mode started (haptic tick, show the outline and scale, remember the finger offset)
 * - tap: a short tap, play the wave animation
 * - save: move mode ended, store the position
 * - cancelLongPress: stop the long-press timer
 */
export type PetTouchEffect = 'vibrate' | 'tap' | 'save' | 'cancelLongPress' | null;

export interface PetTouchStep { phase: PetTouchPhase; effect: PetTouchEffect }

export function reduceTouch(phase: PetTouchPhase, ev: PetTouchEvent): PetTouchStep {
  switch (ev.type) {
    case 'down':
      return phase === 'idle' ? { phase: 'pressing', effect: null } : { phase, effect: null };
    case 'move':
      if (phase === 'pressing' && Math.hypot(ev.dx, ev.dy) > CANCEL_MOVE_PX) {
        return { phase: 'idle', effect: 'cancelLongPress' };
      }
      return { phase, effect: null };
    case 'longPress':
      return phase === 'pressing' ? { phase: 'moving', effect: 'vibrate' } : { phase, effect: null };
    case 'up':
      if (phase === 'pressing') return { phase: 'idle', effect: 'tap' };
      if (phase === 'moving') return { phase: 'idle', effect: 'save' };
      return { phase, effect: null };
    case 'terminate':
      if (phase === 'moving') return { phase: 'idle', effect: 'save' };
      if (phase === 'pressing') return { phase: 'idle', effect: 'cancelLongPress' };
      return { phase, effect: null };
  }
}

/** Whether the responder may be taken away (e.g. by a scroll view): only when not moving the pet. */
export function touchMayBeTaken(phase: PetTouchPhase): boolean {
  return phase !== 'moving';
}
