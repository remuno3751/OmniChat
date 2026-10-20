import { setMessageV4 } from "./db.js";
import type { PhaseRecord } from "./db.js";
import { broadcast } from "./hub.js";

export type Phase = "thinking" | "searching" | "tool" | "subagent" | "answering";

const MAX_PHASES = 100;

/**
 * Tracks the staged status of one assistant message (PROTOCOL-v4 section 2).
 * Each start/end is broadcast as a `phase` frame and the list is persisted on the message.
 */
export class PhaseTracker {
  private readonly records: PhaseRecord[] = [];

  constructor(private readonly userId: string, private readonly conversationId: string, private readonly messageId: string) {}

  /** Opens a phase. Ignored when a phase with the same id is already open, or the list is full. */
  start(phase: Phase, label?: string, id: string = phase): void {
    if (this.records.some((r) => r.id === id && r.end === null)) return;
    if (this.records.length >= MAX_PHASES) return;
    const at = Date.now();
    const rec: PhaseRecord = { id, phase, ...(label ? { label } : {}), start: at, end: null };
    this.records.push(rec);
    this.emit("start", rec, at);
    this.persist();
  }

  /** Closes an open phase. Ignored when no open phase has this id. */
  end(phase: Phase, id: string = phase): void {
    const rec = this.records.find((r) => r.id === id && r.end === null);
    if (!rec) return;
    const at = Date.now();
    rec.end = at;
    this.emit("end", rec, at);
    this.persist();
  }

  /** Ends every open phase (used at every terminal state). */
  closeAll(): void {
    const open = this.records.filter((r) => r.end === null);
    if (!open.length) return;
    const at = Date.now();
    for (const rec of open) {
      rec.end = at;
      this.emit("end", rec, at);
    }
    this.persist();
  }

  get list(): PhaseRecord[] {
    return this.records;
  }

  private emit(state: "start" | "end", rec: PhaseRecord, at: number): void {
    try {
      broadcast(this.userId, {
        type: "phase",
        conversationId: this.conversationId,
        messageId: this.messageId,
        phase: rec.phase,
        state,
        ...(rec.label ? { label: rec.label } : {}),
        at,
        ...(rec.id !== rec.phase ? { id: rec.id } : {}),
      });
    } catch {
      /* broadcasting must never break a run */
    }
  }

  private persist(): void {
    try {
      setMessageV4(this.messageId, { phases: this.records });
    } catch (e) {
      console.warn("phases: persist failed", e);
    }
  }
}
