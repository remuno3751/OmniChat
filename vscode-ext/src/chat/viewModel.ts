/**
 * Pure view-model for the Chat view: the serialisable state posted to the webview, and the
 * validation of messages coming back. No `vscode` import.
 */
import type { StatusState } from "../ui/status";
import { buildApprovalView, parseWebviewMessage, type ApprovalInput, type ApprovalView } from "../ui/approvalModel";
import { stringsFor, type Lang, type Strings } from "../ui/strings";
import { APPROVAL_MODES, type ApprovalModeId } from "../protocol/chat-frames";
import type { ChatSnapshot, ListState } from "./controller";
import { relativeTime, truncateTitle } from "./format";
import type { ChatSupport } from "./support";
import { toolLabel } from "./transcript";

export type ChatBannerKind = "unsupported" | "offline" | "connecting" | "no_models";

export interface ChatBanner {
  kind: ChatBannerKind;
  text: string;
}

/** Decides which banner (if any) the Chat view shows. Priority: unsupported, connection, no models. */
export function buildBanner(input: {
  online: boolean;
  connecting: boolean;
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
  return input.connecting ? { kind: "connecting", text: s.connecting } : { kind: "offline", text: s.offline };
}

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
}

export function buildChatState(input: {
  lang: Lang;
  paired: boolean;
  status: StatusState;
  snapshot: ChatSnapshot;
  approvals: readonly ApprovalInput[];
  /** Current time in ms, for relative times. Defaults to Date.now(). */
  now?: number;
}): ChatViewState {
  const strings = stringsFor(input.lang);
  const now = input.now ?? Date.now();
  const snap = input.snapshot;
  const toolLabels: Record<string, string> = {};
  for (const item of snap.items) if (item.kind === "tool") toolLabels[item.id] = toolLabel(item);
  const err = snap.error;
  const errorText = err === null ? null : err.code === "generic" ? (err.message ?? strings.errors.generic) : strings.errors[err.code];
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
      chatSupport: snap.chatSupport,
      modelsState: snap.modelsState,
      modelCount: snap.models.length,
      strings,
    }),
    chatEnabled: online && snap.chatSupport !== "unsupported",
    title,
    recent,
  };
}

export const MAX_PROMPT_CHARS = 100_000;
const MAX_CODE_CHARS = 8192;
const MAX_COPY_CHARS = 200_000;

/** Messages the Chat webview may post to the host. */
export type ChatMessage =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "stop" }
  | { type: "newConversation" }
  | { type: "refresh" }
  | { type: "refreshHistory" }
  | { type: "openSettings" }
  | { type: "dismissError" }
  | { type: "openConversation"; id: string }
  | { type: "setModel"; ref: string | null }
  | { type: "setApprovalMode"; mode: ApprovalModeId }
  | { type: "setCwd"; cwd: string }
  | { type: "pair"; code: string }
  | { type: "copy"; text: string }
  | { type: "approval_reply"; approvalId: string; decision: "allowed-once" | "rejected" }
  | { type: "viewDiff"; approvalId: string };

const SIMPLE = new Set(["ready", "stop", "newConversation", "refresh", "refreshHistory", "openSettings", "dismissError"]);

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
    case "send": {
      const text = str(m.text, MAX_PROMPT_CHARS);
      return text !== null && text.trim() !== "" ? { type, text } : null;
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
      return null;
  }
}
