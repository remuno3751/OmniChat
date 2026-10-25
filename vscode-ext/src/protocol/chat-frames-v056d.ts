// Chat frames added in v0.5.6-d (0.4.0): per-conversation settings and history search.
// Re-exported from chat-frames.ts. E = extension (VS Code), S = server. Contract: docs/design/V056D-CONTRACT.md.

export type EffortLevel = "off" | "low" | "medium" | "high" | "max";
export const EFFORT_LEVELS: readonly EffortLevel[] = ["off", "low", "medium", "high", "max"];
export type SystemMode = "append" | "replace";
export const SYSTEM_MODES: readonly SystemMode[] = ["append", "replace"];
/** Max length of the system prompt (UTF-16 units) and of a title. */
export const MAX_SYSTEM_PROMPT = 20000;
export const MAX_TITLE = 200;
/** Max results of one history search. */
export const MAX_SEARCH_RESULTS = 30;

/** The per-conversation settings the app calls "this chat". */
export interface ConversationSettings {
  systemPrompt: string;
  systemMode: SystemMode;
  /** null = the model default */
  effort: EffortLevel | null;
}

// E -> S

export interface ConversationSettingsRequestFrame {
  type: "conversation_settings_request";
  requestId: string;
  conversationId: string;
}

/** Every field but the ids is optional: absent keeps the stored value. `title` renames the conversation. */
export interface ConversationSettingsSetFrame {
  type: "conversation_settings_set";
  requestId: string;
  conversationId: string;
  systemPrompt?: string;
  systemMode?: SystemMode;
  effort?: EffortLevel | null;
  title?: string;
}

export interface HistorySearchRequestFrame {
  type: "history_search_request";
  requestId: string;
  query: string;
  limit?: number;
}

// S -> E

export interface ConversationSettingsFrame extends ConversationSettings {
  type: "conversation_settings";
  requestId: string;
  conversationId: string;
  title: string;
}

/** Answer of `conversation_settings_set`: ok with the stored values, or a failure code. */
export interface ConversationSettingsAckFrame {
  type: "conversation_settings_ack";
  requestId: string;
  conversationId: string;
  ok: boolean;
  error?: string;
  message?: string;
  settings?: ConversationSettings;
  title?: string;
}

export interface SearchHit {
  conversationId: string;
  title: string;
  /** Message that matched; absent when only the title did. */
  messageId?: string;
  role?: "user" | "assistant";
  /** Short text around the match; each match is wrapped in \u0001 … \u0002. */
  snippet: string;
  /** ms epoch of the message (or of the conversation for a title hit). */
  at: number;
}

export interface HistorySearchFrame {
  type: "history_search";
  requestId: string;
  query: string;
  results: SearchHit[];
}
