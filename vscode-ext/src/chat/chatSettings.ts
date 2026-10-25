/**
 * Per-conversation settings ("this chat": system prompt, system mode, thinking effort, title) and the
 * history search: the request frames, the answers, and the state they leave in the controller.
 * Every request is tracked by requestId, so a silent server times out. No `vscode` import.
 */
import {
  EFFORT_LEVELS,
  MAX_SEARCH_RESULTS,
  MAX_SYSTEM_PROMPT,
  MAX_TITLE,
  SYSTEM_MODES,
  type EffortLevel,
  type SystemMode,
} from "../protocol/chat-frames";
import type { SearchView, SettingsView } from "./controllerTypes";
import type { RequestDeps } from "./requests";
import type { ChatState } from "./state";

/** Longest search text sent; the server refuses longer ones. */
export const MAX_SEARCH_QUERY = 200;

/** What a save changes. Absent keys keep the stored value; `effort: null` is the model default. */
export interface SettingsInput {
  systemPrompt?: string;
  systemMode?: SystemMode;
  effort?: EffortLevel | null;
  title?: string;
}

/**
 * Checks a save before it is sent. The title is trimmed. Returns null when a field is out of range,
 * so nothing is sent (the prompt may be empty: the server then stores none).
 */
export function normalizeSettingsInput(input: SettingsInput): SettingsInput | null {
  const out: SettingsInput = {};
  if (input.systemPrompt !== undefined) {
    if (typeof input.systemPrompt !== "string" || input.systemPrompt.length > MAX_SYSTEM_PROMPT) return null;
    out.systemPrompt = input.systemPrompt;
  }
  if (input.systemMode !== undefined) {
    if (!SYSTEM_MODES.includes(input.systemMode)) return null;
    out.systemMode = input.systemMode;
  }
  if (input.effort !== undefined) {
    if (input.effort !== null && !EFFORT_LEVELS.includes(input.effort)) return null;
    out.effort = input.effort;
  }
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (title === "" || title.length > MAX_TITLE) return null;
    out.title = title;
  }
  return out;
}

/** The settings and search state the view reads. Settings of another conversation read as idle. */
export function settingsViewOf(st: ChatState): { settings: SettingsView; search: SearchView } {
  const belongs = st.settings.conversationId === st.conversationId;
  return {
    settings: belongs ? { state: st.settings.state, value: st.settings.value } : { state: "idle", value: null },
    search: { query: st.search.query, state: st.search.state, hits: st.search.hits },
  };
}

/** Renames a conversation in the list the controller keeps (the server confirmed the title). */
export function retitle(st: ChatState, conversationId: string, title: string): void {
  st.conversations = st.conversations.map((c) => (c.id === conversationId ? { ...c, title } : c));
}

export interface SettingsRequests {
  /** Asks for the settings of the open conversation. Answered by `conversation_settings`. */
  requestSettings(): void;
  /** Saves some settings (and/or the title). `onResult` is called once: true when the server stored them. */
  saveSettings(input: SettingsInput, onResult?: (ok: boolean) => void): void;
  /** Searches every conversation of this bridge. An empty query clears the search. */
  searchHistory(query: string): void;
  /** Asks for the settings when they are missing or belong to another conversation. Silent otherwise. */
  ensureSettings(): void;
}

/** Builds the settings and search requests on the controller's request deps. */
export function createSettingsRequests(d: RequestDeps): SettingsRequests {
  const { st } = d;
  const canAsk = (): boolean => st.online && d.support() !== "unsupported";

  const requestSettings = (): void => {
    d.pending.drop((r) => r.kind === "settings");
    const conversationId = st.conversationId;
    if (conversationId === null || !canAsk()) {
      st.settings = { conversationId: null, state: "idle", value: null };
      return;
    }
    st.settings = { conversationId, state: "loading", value: null };
    const requestId = d.nextId("g");
    if (!d.send({ type: "conversation_settings_request", requestId, conversationId })) {
      st.settings = { conversationId, state: "error", value: null };
      return;
    }
    d.pending.track(requestId, { kind: "settings", conversationId }, d.timeoutMs);
  };

  const saveSettings = (input: SettingsInput, onResult?: (ok: boolean) => void): void => {
    const body = normalizeSettingsInput(input);
    const conversationId = st.conversationId;
    if (body === null || conversationId === null || !canAsk()) {
      onResult?.(false);
      return;
    }
    const requestId = d.nextId("g");
    const sent = d.send({ type: "conversation_settings_set", requestId, conversationId, ...body });
    if (!sent) {
      onResult?.(false);
      return;
    }
    d.pending.track(
      requestId,
      {
        kind: "settingsSet",
        conversationId,
        onSaved: (ok) => {
          if (ok) requestSettings(); // the stored values are read again after a save
          onResult?.(ok);
        },
      },
      d.timeoutMs,
    );
  };

  const searchHistory = (raw: string): void => {
    const query = raw.trim().slice(0, MAX_SEARCH_QUERY);
    d.pending.drop((r) => r.kind === "search"); // only the newest search counts
    if (query === "") {
      st.search = { query: "", state: "idle", hits: [] };
      return;
    }
    const requestId = d.nextId("q");
    const sent = canAsk() && d.send({ type: "history_search_request", requestId, query, limit: MAX_SEARCH_RESULTS });
    if (sent) d.pending.track(requestId, { kind: "search" }, d.timeoutMs);
    st.search = { query, state: sent ? "loading" : "error", hits: [] };
  };

  return {
    requestSettings: () => {
      requestSettings();
      d.emit();
    },
    saveSettings: (input, onResult) => {
      saveSettings(input, onResult);
      d.emit();
    },
    searchHistory: (query) => {
      searchHistory(query);
      d.emit();
    },
    ensureSettings: () => {
      if (st.conversationId !== null && st.settings.conversationId !== st.conversationId && canAsk()) requestSettings();
    },
  };
}
