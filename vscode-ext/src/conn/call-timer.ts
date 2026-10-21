/**
 * Per-call timeout that can pause (spec docs/design/VSCODE-BRIDGE.md §2.4: approval wait time is not
 * counted). The deadline moves forward by each paused span, so only queued and running time counts.
 */
export interface CallTimerOptions {
  timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
  now: () => number;
  ms: number;
  onExpire: () => void;
}

export interface CallTimer {
  pause(): void;
  resume(): void;
  stop(): void;
}

/** Starts counting at once. `pause` and `resume` may repeat; `stop` ends it for good. */
export function startCallTimer(o: CallTimerOptions): CallTimer {
  let deadline = o.now() + o.ms;
  let handle: unknown = null;
  let pausedAt: number | null = null;
  let stopped = false;

  const arm = (ms: number): void => {
    handle = o.timers.setTimeout(() => {
      handle = null;
      if (!stopped) o.onExpire();
    }, Math.max(0, ms));
  };
  arm(o.ms);

  return {
    pause() {
      if (stopped || pausedAt !== null) return;
      o.timers.clearTimeout(handle);
      handle = null;
      pausedAt = o.now();
    },
    resume() {
      if (stopped || pausedAt === null) return;
      deadline += o.now() - pausedAt;
      pausedAt = null;
      arm(deadline - o.now());
    },
    stop() {
      stopped = true;
      o.timers.clearTimeout(handle);
      handle = null;
    },
  };
}
