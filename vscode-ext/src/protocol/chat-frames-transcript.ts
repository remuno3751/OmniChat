// Transcript item types of the chat frames (split out of chat-frames.ts to keep it small; re-exported there).
import type { SourceItem } from "./chat-frames-v056e";

export type AssistantStatus = "streaming" | "done" | "error" | "stopped";
export type ToolItemStatus = "pending" | "running" | "done" | "error" | "denied";

/** Lines of a file change shown under a tool row. `lines[i]` starts with `+`, `-` or a space. */
export interface ToolDiff {
  path: string;
  added: number;
  removed: number;
  truncated?: boolean;
  lines: string[];
}

/**
 * Assistant items sent while streaming may be deltas (only with `transcriptDelta` on the
 * extension): when `from` is set, `text` is the suffix to append and `from` is the length the
 * current text must have. `reasoningFrom` is the same for `reasoning`. Stored items never keep them.
 */
export type TranscriptItem =
  | { kind: "user"; id: string; text: string }
  | {
      kind: "assistant";
      id: string;
      text: string;
      reasoning?: string;
      status: AssistantStatus;
      from?: number;
      reasoningFrom?: number;
      /** Web sources of the answer (v0.5.6-E). Absent on older servers and while streaming. */
      sources?: SourceItem[];
    }
  | {
      kind: "tool";
      id: string;
      tool: string;
      summary: string;
      status: ToolItemStatus;
      decidedBy?: string;
      durationMs?: number;
      diff?: ToolDiff;
    }
  | { kind: "status"; id?: string; text: string };

/** Streaming re-sends the same item id with the full new text. `reset` replaces the transcript. */
export interface TranscriptFrame {
  type: "transcript";
  conversationId: string;
  runId?: string;
  reset?: boolean;
  items: TranscriptItem[];
}
