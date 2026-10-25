/** Shared contract of the chat webview modules (all DOM code runs in the webview only). */
import type { ChatMessage, ChatViewState } from "../../chat/viewModel";
import type { ConversationSettings, EffortLevel, SearchHit } from "../../protocol/chat-frames-v056d";

export type { ChatMessage, ChatViewState };
/** Posts one message to the extension host. */
export type Send = (msg: ChatMessage) => void;
/** A mounted piece of UI that is re-rendered from each new state. */
export interface Part {
  el: HTMLElement;
  update(state: ChatViewState): void;
}

/**
 * v0.5.5-beta.2 additions (docs/design/V055-CONTRACT.md). Declared here until the host types (ChatViewState.extras,
 * ChatMessage) carry them; `extrasOf` and `sendExtra` are the only places that rely on these declarations.
 */
export type SlashName = "clear" | "context" | "model" | "help" | "compact" | "usage" | "retry" | "pin" | "export" | "effort" | "rename";
export interface SlashEntry {
  name: SlashName;
  desc: string;
}
export interface AttachLimitsView {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  imageMimes: string[];
  visionOk: boolean | null;
}
export interface ExtrasSubset {
  slash: SlashEntry[];
  attach: AttachLimitsView;
}
export interface OutAttachment {
  name: string;
  mime: string;
  data: string;
}
/** Webview -> host messages added in beta.2 (`send`/`sendInterrupt` gain `attachments`). */
/** Webview -> host messages of 0.4.0 (docs/design/V056D-CONTRACT.md). */
export type ExtraMessage =
  | { type: "slash"; name: Exclude<SlashName, "model" | "help">; arg?: string }
  | { type: "send" | "sendInterrupt"; text: string; attachments?: OutAttachment[]; replaceLast?: true }
  | { type: "requestSettings" }
  | { type: "saveSettings"; systemPrompt: string; systemMode: "append" | "replace"; effort: EffortLevel | null }
  | { type: "setEffort"; effort: EffortLevel | null }
  | { type: "searchHistory"; query: string }
  | { type: "openHit"; conversationId: string; messageId?: string };

/** The per-conversation settings as the host sends them (`state.settings`, 0.4.0). */
export interface SettingsView {
  state: "idle" | "loading" | "ready" | "error";
  value: ConversationSettings | null;
}
/** History search as the host reports it (`state.search`, 0.4.0). `query` is the one the hits answer. */
export interface SearchView {
  query: string;
  state: "idle" | "loading" | "ready" | "error";
  hits: SearchHit[];
}

const NO_SETTINGS: SettingsView = { state: "idle", value: null };
const NO_SEARCH: SearchView = { query: "", state: "idle", hits: [] };

/** The settings of a state, or an idle view while the host does not send them. */
export function settingsOf(state: ChatViewState): SettingsView {
  return (state as { settings?: SettingsView }).settings ?? NO_SETTINGS;
}

/** The history search of a state, or an idle view while the host does not send it. */
export function searchOf(state: ChatViewState): SearchView {
  return (state as { search?: SearchView }).search ?? NO_SEARCH;
}

/** Sends a beta.2 message; the host validates it (until ChatMessage lists these types). */
export function sendExtra(send: Send, msg: ExtraMessage): void {
  send(msg as unknown as ChatMessage);
}

/** Host limits (the server's) used until the host sends `extras`. */
export const DEFAULT_ATTACH: AttachLimitsView = {
  maxFiles: 4,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 5 * 1024 * 1024,
  imageMimes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  visionOk: null,
};

/** The extras of a state, or safe defaults while the host does not send them. */
export function extrasOf(state: ChatViewState): ExtrasSubset {
  const x = (state as { extras?: Partial<ExtrasSubset> }).extras;
  return { slash: x?.slash ?? [], attach: x?.attach ?? DEFAULT_ATTACH };
}
