import { isValidChatSFrame } from "./chat-frames";
import type { Frame, FrameType } from "./frames";

/** Maximum frame size in UTF-8 bytes (docs/design/VSCODE-BRIDGE.md §2). */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

const KNOWN_TYPES: ReadonlySet<string> = new Set<FrameType>([
  // E -> S
  "ready",
  "workspaces",
  "run_ack",
  "checkpoint",
  "event",
  "tool_result",
  "approval",
  "approval_decision",
  "changes",
  "done",
  "rewound",
  // S -> E
  "welcome",
  "run",
  "tool_call",
  "cancel",
  "approval_reply",
  "approval_pending",
  "approval_settled",
  "run_end",
  "rewind",
  // Chat (0.2.0)
  "prompt",
  "models_request",
  "conversations_request",
  "conversation_request",
  "set_approval_mode",
  "stop",
  "prompt_ack",
  "models",
  "conversations",
  "transcript",
  "approval_mode",
  "error",
]);

/** Serialize a frame to its JSON text form. */
export function encode(frame: Frame): string {
  return JSON.stringify(frame);
}

/**
 * Parse one text frame. Returns null (never throws) for: oversized frames
 * (> 8 MB UTF-8), invalid JSON, non-object JSON, missing or non-string `type`,
 * and unknown `type`. Unknown fields are kept as-is and do not cause rejection.
 */
export function decode(text: string): Frame | null {
  if (typeof text !== "string") return null;
  if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) return null;

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string" || !KNOWN_TYPES.has(type)) return null;

  // Chat frames from the server are checked field by field; a malformed one is dropped like an unknown one.
  if (!isValidChatSFrame(value as Record<string, unknown>)) return null;
  return value as Frame;
}
