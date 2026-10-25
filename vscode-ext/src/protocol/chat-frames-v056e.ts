// Chat frames added in v0.5.6-E (docs/design/V056E-CONTRACT.md §1): the checkpoint list and restore,
// and the sources of an answer. Split from chat-frames.ts to keep that file small (re-exported there).
// All additive. E = extension (VS Code), S = server.

/** Most checkpoints in one `checkpoints` frame (newest first). */
export const MAX_CHECKPOINTS = 50;
/** Most sources kept on one assistant item. */
export const MAX_SOURCES = 8;

/** One point the files can be restored to: the state before an agent run. */
export interface CheckpointItem {
  id: string;
  createdAt: number;
  /** Uncommitted changes existed in the workspace when the checkpoint was taken. */
  dirty: boolean;
  /** False when the checkpoint has no ref, or it is unavailable (not a Git repository). */
  restorable: boolean;
  /** The user prompt of that run (newlines folded, at most 120 characters). Empty when none. */
  prompt: string;
  /** Changed files of that run's reply. */
  files: number;
  messageId: string;
}

/** Why a restore failed. Unknown values from a newer server are shown as the generic failure. */
export type CheckpointRestoreError = "busy" | "dirty_editors" | "unavailable" | "not_found" | "failed";

// E -> S

/** Asks for the checkpoints of a conversation. Answered by `checkpoints`, or `error` with the requestId. */
export interface CheckpointsRequestFrame {
  type: "checkpoints_request";
  requestId: string;
  conversationId: string;
}

/** Asks to restore the files to a checkpoint. `removeNew` also deletes files created after it. */
export interface CheckpointRestoreFrame {
  type: "checkpoint_restore";
  requestId: string;
  conversationId: string;
  checkpointId: string;
  removeNew?: boolean;
}

// S -> E

export interface CheckpointsFrame {
  type: "checkpoints";
  requestId: string;
  conversationId: string;
  items: CheckpointItem[];
}

export interface CheckpointRestoredFrame {
  type: "checkpoint_restored";
  requestId: string;
  conversationId: string;
  checkpointId: string;
  ok: boolean;
  error?: CheckpointRestoreError;
  message?: string;
}

/** A web source of an answer, shown as a link under the reply. */
export interface SourceItem {
  title: string;
  url: string;
  host: string;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";
const optStr = (v: unknown): boolean => v === undefined || isStr(v);
const TITLE_MAX = 200;
const URL_MAX = 500;

/** One checkpoint row. */
export function isValidCheckpointItem(v: unknown): boolean {
  return (
    isRec(v) &&
    isNonEmpty(v.id) &&
    typeof v.createdAt === "number" &&
    typeof v.dirty === "boolean" &&
    typeof v.restorable === "boolean" &&
    isStr(v.prompt) &&
    typeof v.files === "number" &&
    isStr(v.messageId)
  );
}

/** `checkpoints` (S -> E): a well-formed list of at most MAX_CHECKPOINTS rows. */
export function isValidCheckpointsFrame(frame: Rec): boolean {
  return (
    isNonEmpty(frame.requestId) &&
    isNonEmpty(frame.conversationId) &&
    Array.isArray(frame.items) &&
    frame.items.length <= MAX_CHECKPOINTS &&
    frame.items.every(isValidCheckpointItem)
  );
}

/** `checkpoint_restored` (S -> E). `error` is any string, so a newer server's reason still arrives. */
export function isValidCheckpointRestoredFrame(frame: Rec): boolean {
  return (
    isNonEmpty(frame.requestId) &&
    isNonEmpty(frame.conversationId) &&
    isNonEmpty(frame.checkpointId) &&
    typeof frame.ok === "boolean" &&
    optStr(frame.error) &&
    optStr(frame.message)
  );
}

/**
 * The usable sources of a raw list: http/https only, no user info or fragment in the URL, at most
 * MAX_SOURCES. A bad entry is dropped on its own; the rest are kept.
 */
export function sanitizeSources(raw: unknown): SourceItem[] {
  if (!Array.isArray(raw)) return [];
  const out: SourceItem[] = [];
  for (const entry of raw) {
    if (out.length >= MAX_SOURCES) break;
    if (!isRec(entry) || !isStr(entry.url)) continue;
    const url = httpUrl(entry.url);
    if (url === null) continue;
    const host = new URL(url).hostname;
    const title = isStr(entry.title) && entry.title.trim() !== "" ? entry.title.trim().slice(0, TITLE_MAX) : host;
    out.push({ title, url, host });
  }
  return out;
}

/** The URL as http/https text without user info or fragment, or null. Also used by the host for openExternal. */
export function httpUrl(raw: string): string | null {
  if (raw.length > URL_MAX * 4) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username !== "" || u.password !== "") return null;
  u.hash = "";
  const text = u.toString();
  return text.length <= URL_MAX ? text : null;
}

/**
 * Sanitizes the `sources` of every assistant item of a decoded `transcript` frame, in place (run by the
 * codec, so an item with bad sources is kept and only its sources are dropped). An empty or invalid list is removed.
 */
export function sanitizeTranscriptSources(frame: Rec): void {
  if (!Array.isArray(frame.items)) return;
  for (const item of frame.items) {
    if (!isRec(item) || item.kind !== "assistant" || item.sources === undefined) continue;
    const clean = sanitizeSources(item.sources);
    if (clean.length > 0) item.sources = clean;
    else delete item.sources;
  }
}
