// Validation of the S -> E frames added in v0.5.6-d (conversation settings, history search).
// Kept apart from chat-frames.ts to keep that file small. Unknown fields never fail a frame.
import { EFFORT_LEVELS, SYSTEM_MODES, type EffortLevel } from "./chat-frames-v056d";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";
const optStr = (v: unknown): boolean => v === undefined || isStr(v);

/** The settings fields of a `conversation_settings` frame, or of the `settings` of an ack. */
function isValidSettings(v: unknown): boolean {
  return (
    isRec(v) &&
    isStr(v.systemPrompt) &&
    SYSTEM_MODES.includes(v.systemMode as (typeof SYSTEM_MODES)[number]) &&
    (v.effort === null || EFFORT_LEVELS.includes(v.effort as EffortLevel))
  );
}

function isValidHit(h: unknown): boolean {
  return (
    isRec(h) &&
    isNonEmpty(h.conversationId) &&
    isStr(h.title) &&
    optStr(h.messageId) &&
    (h.role === undefined || h.role === "user" || h.role === "assistant") &&
    isStr(h.snippet) &&
    typeof h.at === "number"
  );
}

/** True when an S -> E frame of the v0.5.6-d types is well formed. Other types always pass. */
export function isValidV056dSFrame(frame: Rec): boolean {
  switch (frame.type) {
    case "conversation_settings":
      return (
        isNonEmpty(frame.requestId) &&
        isNonEmpty(frame.conversationId) &&
        isValidSettings(frame) &&
        isStr(frame.title)
      );
    case "conversation_settings_ack":
      if (!isNonEmpty(frame.requestId) || !isNonEmpty(frame.conversationId) || typeof frame.ok !== "boolean") return false;
      if (frame.ok === false) return optStr(frame.error) && optStr(frame.message);
      return (frame.settings === undefined || isValidSettings(frame.settings)) && optStr(frame.title);
    case "history_search":
      return (
        isNonEmpty(frame.requestId) &&
        isStr(frame.query) &&
        Array.isArray(frame.results) &&
        frame.results.every(isValidHit)
      );
    default:
      return true;
  }
}
