/** Pure row model of the checkpoint panel (no DOM, unit-tested in node). */
import type { CheckpointItem, V056eStrings } from "./v056eTypes";

/** The host sends at most this many checkpoints; the panel never draws more. */
export const CP_MAX_ROWS = 50;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** `HH:mm` for today, `M/D HH:mm` for any other day (local time). */
export function formatCpTime(ts: number, now: number): string {
  const d = new Date(ts);
  const n = new Date(now);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const today = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return today ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

export interface CheckpointRow {
  id: string;
  time: string;
  dirty: boolean;
  /** The full prompt (the row shows it cut); "" when there is none. */
  prompt: string;
  files: string;
  restorable: boolean;
  /** Text of the restore button (`cpRestoring` on the row being restored). */
  restoreLabel: string;
  restoring: boolean;
  /** The restore button does nothing (unavailable, busy, or another restore is running). */
  restoreOff: boolean;
  /** Tooltip explaining why restore is off; null when it is on. */
  restoreTip: string | null;
}

export interface RowContext {
  now: number;
  /** A run or a prompt is going: nothing can be restored. */
  busy: boolean;
  /** The id being restored, or null. */
  restoring: string | null;
}

export function buildCheckpointRow(item: CheckpointItem, ctx: RowContext, S: V056eStrings): CheckpointRow {
  const restoring = ctx.restoring === item.id;
  const busy = ctx.busy;
  let restoreTip: string | null = null;
  if (!item.restorable) restoreTip = S.cpUnavailable;
  else if (busy) restoreTip = S.cpBusy;
  return {
    id: item.id,
    time: formatCpTime(item.createdAt, ctx.now),
    dirty: item.dirty,
    prompt: item.prompt,
    files: item.files > 0 ? S.cpFiles.replace("{n}", String(item.files)) : S.cpNoChange,
    restorable: item.restorable,
    restoreLabel: restoring ? S.cpRestoring : S.cpRestore,
    restoring,
    restoreOff: !item.restorable || busy || ctx.restoring !== null,
    restoreTip,
  };
}

/** The rows of a list, in the host's order (newest first), capped at CP_MAX_ROWS. */
export function buildCheckpointRows(items: readonly CheckpointItem[], ctx: RowContext, S: V056eStrings): CheckpointRow[] {
  return items.slice(0, CP_MAX_ROWS).map((item) => buildCheckpointRow(item, ctx, S));
}
