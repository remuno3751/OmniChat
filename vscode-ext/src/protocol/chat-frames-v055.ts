// Chat frames added in v0.5.5-beta.2: attachments, devices, compaction, and the model fields.
// Kept apart from chat-frames.ts (which re-exports everything here) to keep both files small.
// All additive. E = extension (VS Code), S = server.

export type VisionState = "yes" | "no" | "unknown";
export const VISION_STATES: readonly VisionState[] = ["yes", "no", "unknown"];

/** A file sent with a prompt. `data` is the base64 of the file. Limits: see chat/attach.ts. */
export interface PromptAttachment {
  name: string;
  mime: string;
  data: string;
}

export type DeviceKind = "vscode" | "dsh";

/** One of the user's online bridges. `self` marks the bridge that asked. */
export interface DeviceItem {
  name: string;
  kind: DeviceKind;
  online: boolean;
  self: boolean;
  workspaces: string[];
}

/** Max items in a `devices` frame, and max workspaces per item. */
export const MAX_DEVICES = 50;

// E -> S

/** Asks which of the user's bridges are online. Answered by a `devices` frame. */
export interface DevicesRequestFrame {
  type: "devices_request";
  requestId: string;
}

/** Asks the server to summarise the conversation. Answered by `compacted`, or an `error` with the requestId. */
export interface CompactRequestFrame {
  type: "compact_request";
  requestId: string;
  conversationId: string;
}

// S -> E

export interface DevicesFrame {
  type: "devices";
  requestId: string;
  items: DeviceItem[];
}

/** Context usage of a conversation before and after compaction, in tokens. */
export interface CompactedFrame {
  type: "compacted";
  requestId: string;
  conversationId: string;
  ok: true;
  before: number;
  after: number;
}

/** Tokens of the next request by part: the system prompt, the history, attachments, tool definitions, the draft. */
export interface ContextUsedTokens {
  system: number;
  history: number;
  attachments: number;
  tools: number;
  input: number;
}

/** Tokens of the latest finished assistant message. */
export interface ContextLastTokens {
  prompt: number;
  completion: number;
  reasoning: number;
}

/** The optional breakdown fields of a `context` frame. A field the server did not know is absent. */
export interface ContextBreakdownFields {
  used?: ContextUsedTokens;
  reasoning?: number;
  last?: ContextLastTokens;
}

// Validation (S -> E only).

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";
const DEVICE_KINDS: readonly unknown[] = ["vscode", "dsh"];

/** The v0.5.5-beta.2 fields of a model item (`contextLength`, `vision`) when present. */
export function isValidModelExtras(m: Rec): boolean {
  return (
    (m.contextLength === undefined || typeof m.contextLength === "number") &&
    (m.vision === undefined || (VISION_STATES as readonly unknown[]).includes(m.vision))
  );
}

function validDevice(d: unknown): boolean {
  return (
    isRec(d) &&
    isStr(d.name) &&
    DEVICE_KINDS.includes(d.kind) &&
    typeof d.online === "boolean" &&
    typeof d.self === "boolean" &&
    Array.isArray(d.workspaces) &&
    d.workspaces.length <= MAX_DEVICES &&
    d.workspaces.every(isStr)
  );
}

/** Validates a `devices` frame (type already checked by the caller). */
export function isValidDevicesFrame(frame: Rec): boolean {
  return (
    isNonEmpty(frame.requestId) &&
    Array.isArray(frame.items) &&
    frame.items.length <= MAX_DEVICES &&
    frame.items.every(validDevice)
  );
}

/** Validates a `compacted` frame (type already checked by the caller). */
export function isValidCompactedFrame(frame: Rec): boolean {
  return (
    isNonEmpty(frame.requestId) &&
    isNonEmpty(frame.conversationId) &&
    frame.ok === true &&
    typeof frame.before === "number" &&
    typeof frame.after === "number"
  );
}

/** The fields of a `context` frame the breakdown is read from. */
type BreakdownSource = { used?: unknown; reasoning?: unknown; last?: unknown };

const USED_KEYS = ["system", "history", "attachments", "tools", "input"] as const;
const LAST_KEYS = ["prompt", "completion", "reasoning"] as const;
const hasNumbers = (v: unknown, keys: readonly string[]): boolean =>
  isRec(v) && keys.every((k) => typeof v[k] === "number");

/** Validates the optional breakdown fields of a `context` frame: each one present must be well formed. */
export function isValidContextBreakdown(frame: BreakdownSource): boolean {
  return (
    (frame.used === undefined || hasNumbers(frame.used, USED_KEYS)) &&
    (frame.reasoning === undefined || typeof frame.reasoning === "number") &&
    (frame.last === undefined || hasNumbers(frame.last, LAST_KEYS))
  );
}

/** The breakdown fields of a validated `context` frame; only the fields that are present. */
export function contextBreakdownOf(frame: BreakdownSource): ContextBreakdownFields {
  const out: ContextBreakdownFields = {};
  if (frame.used !== undefined) {
    const u = frame.used as Record<string, number>;
    out.used = { system: u.system, history: u.history, attachments: u.attachments, tools: u.tools, input: u.input };
  }
  if (frame.reasoning !== undefined) out.reasoning = frame.reasoning as number;
  if (frame.last !== undefined) {
    const l = frame.last as Record<string, number>;
    out.last = { prompt: l.prompt, completion: l.completion, reasoning: l.reasoning };
  }
  return out;
}
