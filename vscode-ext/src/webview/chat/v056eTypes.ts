/**
 * Structural types and accessors of the v0.5.6-E webview features (docs/design/V056E-CONTRACT.md §1-§4).
 * Checkpoint and source shapes come from protocol/chat-frames-v056e.ts (W-H). The view model
 * (chat/viewModelV056e.ts) and the wording (ui/stringsV056e.ts) are not there yet, so they are declared here; switch
 * them to imports when those files land.
 */
import type { ChatMessage, ChatViewState, Send } from "./types";

export type CheckpointState = "idle" | "loading" | "ready" | "error";

import type { CheckpointItem } from "../../protocol/chat-frames-v056e";
export type { CheckpointItem };

export interface CheckpointsView {
  state: CheckpointState;
  items: CheckpointItem[];
  restoring: string | null;
  error: string | null;
}

export interface V056eView {
  checkpoints: CheckpointsView;
}

/** A web source of an answer (assistant item `sources`, at most 8). */
export type { SourceItem as Source } from "../../protocol/chat-frames-v056e";

/** The v0.5.6-E wording the webview draws (keys of stringsV056e.ts). */
export interface V056eStrings {
  cpTitle: string;
  cpHint: string;
  cpEmpty: string;
  cpLoading: string;
  cpError: string;
  cpReload: string;
  cpRestore: string;
  cpRestoring: string;
  cpDirty: string;
  cpUnavailable: string;
  cpBusy: string;
  cpFiles: string;
  cpNoChange: string;
  cpButtonTip: string;
  srcTitle(n: number): string;
  srcOpen: string;
  editLabel: string;
  editBannerText: string;
  editCancel: string;
  editSendTip: string;
}

/** Webview -> host messages of v0.5.6-E (validated by the host's parseChatMessage). */
export type V056eMessage =
  | { type: "requestCheckpoints" }
  | { type: "restoreCheckpoint"; checkpointId: string }
  | { type: "openExternal"; url: string };

const EMPTY_VIEW: V056eView = { checkpoints: { state: "idle", items: [], restoring: null, error: null } };

/** The v0.5.6-E view of a state, or an empty one while the host does not send it. */
export function viewOf(state: ChatViewState): V056eView {
  return (state as unknown as { v056e?: V056eView }).v056e ?? EMPTY_VIEW;
}

/** The v0.5.6-E wording of a state (the strings object the host builds per language). */
export function stringsOf(state: ChatViewState): V056eStrings {
  return state.strings as unknown as V056eStrings;
}

/** Sends a v0.5.6-E message; the host validates it (until ChatMessage lists these types). */
export function sendV056e(send: Send, msg: V056eMessage): void {
  send(msg as unknown as ChatMessage);
}
