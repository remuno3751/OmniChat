/**
 * Pure view-model for the Chat view: the serialisable state posted to the webview, and the
 * validation of messages coming back. No `vscode` import.
 */
import type { StatusState } from "../ui/status";
import { buildApprovalView, parseWebviewMessage, type ApprovalInput, type ApprovalView } from "../ui/approvalModel";
import { stringsFor, type Lang, type Strings } from "../ui/strings";
import { APPROVAL_MODES, SEARCH_MODES, type ApprovalModeId, type PromptAttachment, type SearchMode } from "../protocol/chat-frames";
import type { RetryInfo } from "../conn/client";
import type { ChatSnapshot, ChatError, ListState } from "./controller";
import type { SearchView, SettingsView } from "./controllerTypes";
import { parseAttachments } from "./attach";
import { buildContextView, type ContextView } from "./contextView";
import { buildExtras, errorTextOf, type ExtrasView } from "./extrasModel";
import { relativeTime, truncateTitle } from "./format";
import type { FavoriteKind, Favorites } from "./favorites";
import type { ChatMessage } from "./messages";
import { parseSettingsMessage } from "./settingsMessages";
import { buildV056eView, parseV056eMessage, type V056eView } from "./viewModelV056e";
export type { ChatMessage };
import type { SlashCommand } from "./slash";
import type { ChatSupport } from "./support";
import { toolLabel } from "./transcript";

export type ChatBannerKind = "unsupported" | "offline" | "connecting" | "reconnecting" | "no_models";

export interface ChatBanner {
  kind: ChatBannerKind;
  text: string;
}

/** Decides which banner (if any) the Chat view shows. Priority: unsupported, connection, no models. */
export function buildBanner(input: {
  online: boolean;
  connecting: boolean;
  /** Seconds until the next reconnect when one is scheduled; null otherwise. */
  reconnectSec?: number | null;
  chatSupport: ChatSupport;
  modelsState: ListState;
  modelCount: number;
  strings: Strings;
}): ChatBanner | null {
  const s = input.strings;
  if (input.online) {
    if (input.chatSupport === "unsupported") return { kind: "unsupported", text: s.unsupportedServer };
    if (input.modelsState === "ready" && input.modelCount === 0) return { kind: "no_models", text: s.noModels };
    return null;
  }
  if (input.connecting) return { kind: "connecting", text: s.connecting };
  if (input.reconnectSec !== undefined && input.reconnectSec !== null) {
    return { kind: "reconnecting", text: s.reconnecting.replace("{sec}", String(Math.max(1, input.reconnectSec))) };
  }
  return { kind: "offline", text: s.offline };
}

/** Connection facts from the host: the last ping round trip and the scheduled reconnect, if any. */
export interface LinkInfo {
  rttMs: number | null;
  reconnect: RetryInfo | null;
}

/** The link as the webview draws it: the retry countdown instead of the absolute time. */
export interface LinkView {
  rttMs: number | null;
  reconnect: { attempt: number; retryInMs: number } | null;
}

/** Mean of the recent ping round trips, rounded; null when there are none. */
export function averageRtt(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

export { buildContextView, formatTokens, type ContextView, type TokenBreakdown, type TokenRow } from "./contextView";

export interface RecentConversation {
  id: string;
  title: string;
  updatedAt: number;
  /** Short relative time, e.g. "5m ago" or "昨日". */
  relative: string;
  approvalMode: ApprovalModeId;
  approvalLabel: string;
  current: boolean;
}

const MAX_TITLE_CHARS = 80;

export interface ChatViewState {
  lang: Lang;
  strings: Strings;
  paired: boolean;
  status: StatusState;
  snapshot: ChatSnapshot;
  /** Pre-rendered tool labels by item id (so the webview holds no formatting rules). */
  toolLabels: Record<string, string>;
  approvals: ApprovalView[];
  /** Short text for the last error, already localised. */
  errorText: string | null;
  banner: ChatBanner | null;
  /** False while offline or when the server is too old for chat. */
  chatEnabled: boolean;
  /** Title of the open conversation, or the "new chat" label. */
  title: string;
  /** Conversation list for the history panel, newest first. */
  recent: RecentConversation[];
  link: LinkView;
  context: ContextView | null;
  /** Slash menu, attachment limits, devices and favourites for the composer and its popovers. */
  extras: ExtrasView;
  /** Settings of the open conversation ("this chat"): value null until loaded. */
  settings: SettingsView;
  /** The last history search (query, state, hits). */
  search: SearchView;
  /** Checkpoints panel state (v0.5.6-E). */
  v056e: V056eView;
}

export function buildChatState(input: {
  lang: Lang;
  paired: boolean;
  status: StatusState;
  snapshot: ChatSnapshot;
  approvals: readonly ApprovalInput[];
  /** Connection facts from the host. */
  link?: LinkInfo;
  /** Pinned devices and folders. Empty when not given. */
  favorites?: Favorites;
  /** Current time in ms, for relative times. Defaults to Date.now(). */
  now?: number;
}): ChatViewState {
  const strings = stringsFor(input.lang);
  const now = input.now ?? Date.now();
  const snap = input.snapshot;
  const toolLabels: Record<string, string> = {};
  for (const item of snap.items) if (item.kind === "tool") toolLabels[item.id] = toolLabel(item);
  const err = snap.error;
  const errorText = err === null ? null : errorTextOf(err, strings);
  const online = snap.online;
  const modeLabel = (mode: ApprovalModeId): string =>
    mode === "auto" ? strings.modeAuto : mode === "full" ? strings.modeFull : strings.modeManual;
  const recent: RecentConversation[] = snap.conversations.map((c) => ({
    id: c.id,
    title: c.title.trim() === "" ? strings.untitled : truncateTitle(c.title, MAX_TITLE_CHARS),
    updatedAt: c.updatedAt,
    relative: relativeTime(c.updatedAt, now, input.lang),
    approvalMode: c.approvalMode,
    approvalLabel: modeLabel(c.approvalMode),
    current: c.id === snap.conversationId,
  }));
  const current = snap.conversations.find((c) => c.id === snap.conversationId);
  const title = current && current.title.trim() !== "" ? truncateTitle(current.title, MAX_TITLE_CHARS) : strings.newChat;
  const link = input.link ?? { rttMs: null, reconnect: null };
  const reconnect = link.reconnect;
  return {
    lang: input.lang,
    strings,
    paired: input.paired,
    status: input.status,
    snapshot: snap,
    toolLabels,
    approvals: input.approvals.map((a) => buildApprovalView(a, input.lang)),
    errorText,
    banner: buildBanner({
      online,
      connecting: input.status === "connecting",
      reconnectSec:
        reconnect === null || online ? null : Math.ceil(Math.max(0, reconnect.nextRetryAt - now) / 1000),
      chatSupport: snap.chatSupport,
      modelsState: snap.modelsState,
      modelCount: snap.models.length,
      strings,
    }),
    chatEnabled: online && snap.chatSupport !== "unsupported",
    title,
    recent,
    link: {
      rttMs: link.rttMs,
      reconnect:
        reconnect === null ? null : { attempt: reconnect.attempt, retryInMs: Math.max(0, reconnect.nextRetryAt - now) },
    },
    context: buildContextView(snap.context, strings),
    v056e: buildV056eView(snap, strings),
    extras: buildExtras({
      strings,
      snapshot: snap,
      favorites: input.favorites ?? { devices: [], folders: [] },
    }),
    settings: snap.settings,
    search: snap.search,
  };
}

export const MAX_PROMPT_CHARS = 100_000;
const MAX_FAV_KEY_CHARS = 1024; // a favourite: device name or folder path
const MAX_CODE_CHARS = 8192;
const MAX_COPY_CHARS = 200_000;

const SIMPLE = new Set([
  "ready",
  "stop",
  "newConversation",
  "refresh",
  "refreshHistory",
  "openSettings",
  "toggleSettings",
  "dismissError",
  "draftChanged",
  "requestDevices",
  "openInEditor",
]);

/** Slash commands the host runs. `model` and `help` are answered inside the webview. */
const SLASH_HOST: readonly string[] = ["clear", "context", "compact"];

/** Longest path a webview may ask to open. */
export const MAX_OPEN_PATH_CHARS = 1000;
/** Largest line number accepted by openFile. */
const MAX_OPEN_LINE = 10_000_000;

/** Validates a webview message. Anything unexpected returns null. */
export function parseChatMessage(raw: unknown): ChatMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const type = m.type;
  if (typeof type !== "string") return null;
  if (SIMPLE.has(type)) return { type } as ChatMessage;
  if (type === "approval_reply" || type === "viewDiff") return parseWebviewMessage(raw) as ChatMessage | null;
  const str = (v: unknown, max: number): string | null =>
    typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
  switch (type) {
    case "send":
    case "sendInterrupt": {
      const text = str(m.text, MAX_PROMPT_CHARS);
      const attachments = parseAttachments(m.attachments);
      if (text === null || text.trim() === "" || attachments === null) return null;
      const replace = m.replaceLast === true ? { replaceLast: true as const } : {};
      return attachments.length > 0 ? { type, text, attachments, ...replace } : { type, text, ...replace };
    }
    case "slash":
      return SLASH_HOST.includes(m.name as string) ? { type, name: m.name as SlashCommand } : null;
    case "toggleFavorite": {
      const key = str(m.key, MAX_FAV_KEY_CHARS);
      const kind = m.kind;
      return (kind === "device" || kind === "folder") && key !== null ? { type, kind, key } : null;
    }
    case "cancelQueued":
    case "interruptQueued": {
      const id = str(m.id, 64);
      return id !== null ? { type, id } : null;
    }
    case "regenerate": {
      const id = str(m.id, 256); // an assistant item id
      return id !== null ? { type, id } : null;
    }
    case "setSearchMode":
      return SEARCH_MODES.includes(m.mode as SearchMode) ? { type, mode: m.mode as SearchMode } : null;
    case "openFile": {
      const path = str(m.path, MAX_OPEN_PATH_CHARS);
      if (path === null || path.trim() === "" || /[\x00-\x1f]/.test(path)) return null;
      if (m.line === undefined) return { type, path };
      const line = m.line;
      return typeof line === "number" && Number.isInteger(line) && line >= 1 && line <= MAX_OPEN_LINE
        ? { type, path, line }
        : null;
    }
    case "copy": {
      const text = str(m.text, MAX_COPY_CHARS);
      return text !== null ? { type, text } : null;
    }
    case "openConversation": {
      const id = str(m.id, 256);
      return id !== null ? { type, id } : null;
    }
    case "setModel":
      if (m.ref === null) return { type, ref: null };
      return str(m.ref, 512) !== null ? { type, ref: m.ref as string } : null;
    case "setApprovalMode":
      return APPROVAL_MODES.includes(m.mode as ApprovalModeId) ? { type, mode: m.mode as ApprovalModeId } : null;
    case "setCwd": {
      const cwd = str(m.cwd, 4096);
      return cwd !== null ? { type, cwd } : null;
    }
    case "pair": {
      const code = str(m.code, MAX_CODE_CHARS);
      return code !== null ? { type, code } : null;
    }
    default:
      return parseSettingsMessage(type, m) ?? parseV056eMessage(m);
  }
}
