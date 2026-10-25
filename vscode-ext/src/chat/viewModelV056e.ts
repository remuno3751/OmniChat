/**
 * The v0.5.6-E part of the Chat view model (docs/design/V056E-CONTRACT.md §2): the checkpoints panel
 * state, the time label of a checkpoint, and the parse of the three messages the panel and the answer
 * cards send (requestCheckpoints, restoreCheckpoint, openExternal). No `vscode` import.
 */
import type { CheckpointItem } from "../protocol/chat-frames";
import { httpUrl } from "../protocol/chat-frames-v056e";
import type { Strings } from "../ui/strings";
import type { ChatMessage } from "./messages";
import type { ChatSnapshot } from "./controllerTypes";

/** What the webview gets for the checkpoints panel. */
export interface V056eView {
  checkpoints: {
    state: "idle" | "loading" | "ready" | "error";
    items: CheckpointItem[];
    /** The checkpoint being restored, or null. */
    restoring: string | null;
    /** The failure text when the list could not be read, else null. */
    error: string | null;
  };
}

/**
 * The panel state of the open conversation. A list read for another conversation is not shown
 * (it shows as idle until the panel asks again).
 */
export function buildV056eView(snap: ChatSnapshot, strings: Strings): V056eView {
  const cp = snap.checkpoints;
  const mine = cp.conversationId === snap.conversationId;
  return {
    checkpoints: {
      state: mine ? cp.state : "idle",
      items: mine ? cp.items : [],
      restoring: mine ? cp.restoring : null,
      error: mine && cp.error ? strings.cpError : null,
    },
  };
}

const two = (n: number): string => String(n).padStart(2, "0");

/**
 * `HH:mm` for a checkpoint made today, `M/D HH:mm` otherwise (local time). Used in the restore
 * confirmation and the status line; the webview formats its own rows.
 */
export function checkpointTimeLabel(createdAt: number, now: number): string {
  const d = new Date(createdAt);
  const n = new Date(now);
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

const MAX_ID_CHARS = 256;

/** Parses the v0.5.6-E webview messages. Anything else returns null. */
export function parseV056eMessage(m: Record<string, unknown>): ChatMessage | null {
  switch (m.type) {
    case "requestCheckpoints":
      return { type: "requestCheckpoints" };
    case "restoreCheckpoint":
      return typeof m.checkpointId === "string" && m.checkpointId !== "" && m.checkpointId.length <= MAX_ID_CHARS
        ? { type: "restoreCheckpoint", checkpointId: m.checkpointId }
        : null;
    case "openExternal": {
      const url = typeof m.url === "string" ? httpUrl(m.url) : null;
      return url !== null ? { type: "openExternal", url } : null;
    }
    default:
      return null;
  }
}
