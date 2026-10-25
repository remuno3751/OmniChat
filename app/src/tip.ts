// Hover hint logic (pure, no React Native import so it can be unit-tested).
export const TIP_DELAY_MS = 2000;

/** True only on web with a fine hover pointer (mouse / trackpad). Touch devices never show tips. */
export function canHover(os: string, win: any = (globalThis as any).window): boolean {
  if (os !== 'web') return false;
  try {
    const mm = win?.matchMedia;
    return typeof mm === 'function' && !!mm('(hover: hover) and (pointer: fine)').matches;
  } catch {
    return false;
  }
}

export interface TipTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (id: unknown) => void;
}

const realTimers: TipTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as any),
};

/** The tip currently on screen. Showing another tip hides this one first. */
let visible: { hide: () => void } | null = null;

/**
 * Hover state machine for one tip. `enter` starts the delay, `leave` / `hide` (press, scroll)
 * cancel it or close the tip at once. `onOpenChange` is called only when the open state changes.
 */
export function createTip(onOpenChange: (open: boolean) => void, timers: TipTimers = realTimers, delay = TIP_DELAY_MS) {
  let timer: unknown = null;
  let open = false;
  const token = { hide: () => hide() };

  const cancel = () => {
    if (timer !== null) {
      timers.clear(timer);
      timer = null;
    }
  };
  const hide = () => {
    cancel();
    if (!open) return;
    open = false;
    if (visible === token) visible = null;
    onOpenChange(false);
  };

  return {
    enter() {
      if (open || timer !== null) return;
      timer = timers.set(() => {
        timer = null;
        if (visible && visible !== token) visible.hide();
        visible = token;
        open = true;
        onOpenChange(true);
      }, delay);
    },
    leave: hide,
    hide,
    dispose: hide,
    get isOpen() {
      return open;
    },
  };
}
