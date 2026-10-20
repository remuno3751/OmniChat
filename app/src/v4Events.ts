// Tiny in-app event bus for v4 WS frames that do not belong to the store (notify, checkpoints).
import type { ServerMsg } from './protocol';

export type NotifyFrame = Extract<ServerMsg, { type: 'notify' }>;
export type CheckpointFrame = Extract<ServerMsg, { type: 'checkpoint' | 'checkpoint_unavailable' }>;

function bus<T>() {
  const subs = new Set<(f: T) => void>();
  return {
    on(cb: (f: T) => void): () => void {
      subs.add(cb);
      return () => { subs.delete(cb); };
    },
    emit(f: T) {
      subs.forEach((cb) => { try { cb(f); } catch {} });
    },
  };
}

const notifyBus = bus<NotifyFrame>();
const checkpointBus = bus<CheckpointFrame>();

/** Subscribe to WS `notify` frames (OS notifications, pets). Returns an unsubscribe function. */
export const onNotify = notifyBus.on;
export const emitNotify = (frame: NotifyFrame) => notifyBus.emit(frame);

/** Subscribe to WS `checkpoint` / `checkpoint_unavailable` frames. Returns an unsubscribe function. */
export const onCheckpoint = checkpointBus.on;
export const emitCheckpoint = (frame: CheckpointFrame) => checkpointBus.emit(frame);
