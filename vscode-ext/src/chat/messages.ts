/**
 * The messages the Chat webview may post to the host (validated by parseChatMessage in viewModel.ts).
 * Split out of viewModel.ts to keep that file small. Types only.
 */
import type { ApprovalModeId, EffortLevel, PromptAttachment, SearchMode, SystemMode } from "../protocol/chat-frames";
import type { FavoriteKind } from "./favorites";
import type { SlashCommand } from "./slash";

/** Settings and history search messages (v0.5.6-d). */
export type SettingsMessage =
  | { type: "requestSettings" }
  | { type: "saveSettings"; systemPrompt: string; systemMode: SystemMode; effort: EffortLevel | null }
  | { type: "setEffort"; effort: EffortLevel | null }
  | { type: "searchHistory"; query: string }
  | { type: "openHit"; conversationId: string; messageId?: string };

/** Messages the Chat webview may post to the host. */
export type ChatMessage =
  | SettingsMessage
  | { type: "ready" }
  | { type: "send"; text: string; attachments?: PromptAttachment[]; replaceLast?: true }
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
  | { type: "viewDiff"; approvalId: string }
  | { type: "sendInterrupt"; text: string; attachments?: PromptAttachment[]; replaceLast?: true }
  | { type: "slash"; name: SlashCommand }
  | { type: "requestDevices" }
  | { type: "toggleFavorite"; kind: FavoriteKind; key: string }
  | { type: "cancelQueued"; id: string }
  | { type: "interruptQueued"; id: string }
  | { type: "regenerate"; id: string }
  | { type: "openInEditor" }
  | { type: "dockRight" }
  | { type: "setSearchMode"; mode: SearchMode }
  | { type: "toggleSettings" }
  | { type: "draftChanged" }
  | { type: "openFile"; path: string; line?: number }
  // v0.5.6-E (parsed in viewModelV056e.ts)
  | { type: "requestCheckpoints" }
  | { type: "restoreCheckpoint"; checkpointId: string }
  | { type: "openExternal"; url: string };
