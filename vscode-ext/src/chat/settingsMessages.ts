/**
 * Validation of the settings and history search messages the Chat webview posts (v0.5.6-d). Split out of
 * viewModel.ts to keep that file small. No `vscode` import.
 */
import { EFFORT_LEVELS, MAX_SYSTEM_PROMPT, SYSTEM_MODES, type EffortLevel, type SystemMode } from "../protocol/chat-frames";
import type { ChatMessage } from "./messages";

/** Longest search text the webview may send; the controller trims it and cuts it to 200 characters. */
const MAX_SEARCH_INPUT = 1000;
const MAX_ID_CHARS = 256;

/** An effort value: a level, null for the model default, or undefined when it is not one of those. */
function effortOf(v: unknown): EffortLevel | null | undefined {
  if (v === null) return null;
  return EFFORT_LEVELS.includes(v as EffortLevel) ? (v as EffortLevel) : undefined;
}

/**
 * The message for one of the settings types, `null` when its fields are invalid, or `undefined` when `type` is
 * not one of them (the caller decides what that means).
 */
export function parseSettingsMessage(type: string, m: Record<string, unknown>): ChatMessage | null | undefined {
  switch (type) {
    case "requestSettings":
      return { type };
    case "saveSettings": {
      const effort = effortOf(m.effort);
      if (typeof m.systemPrompt !== "string" || m.systemPrompt.length > MAX_SYSTEM_PROMPT) return null;
      if (!SYSTEM_MODES.includes(m.systemMode as SystemMode) || effort === undefined) return null;
      return { type, systemPrompt: m.systemPrompt, systemMode: m.systemMode as SystemMode, effort };
    }
    case "setEffort": {
      const effort = effortOf(m.effort);
      return effort === undefined ? null : { type, effort };
    }
    case "searchHistory":
      return typeof m.query === "string" && m.query.length <= MAX_SEARCH_INPUT ? { type, query: m.query } : null;
    case "openHit": {
      const { conversationId: id, messageId: msg } = m;
      if (typeof id !== "string" || id === "" || id.length > MAX_ID_CHARS) return null;
      if (msg !== undefined && (typeof msg !== "string" || msg.length > MAX_ID_CHARS)) return null;
      return msg === undefined ? { type, conversationId: id } : { type, conversationId: id, messageId: msg };
    }
    default:
      return undefined;
  }
}
