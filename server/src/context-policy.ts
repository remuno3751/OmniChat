import { getSettings } from "./projects.js";
import type { ContextOverflow } from "./projects.js";

const VALID: readonly string[] = ["truncate", "summarize", "stop"];

/** Overflow policy for one chat: the chat's own override, else the user's default (chat > user > built-in). */
export function effectiveOverflow(userId: string, conv: { context_overflow?: unknown; contextOverflow?: unknown } | null | undefined): ContextOverflow {
  const own = conv?.context_overflow ?? conv?.contextOverflow;
  if (typeof own === "string" && VALID.includes(own)) return own as ContextOverflow;
  return getSettings(userId).contextOverflow;
}
