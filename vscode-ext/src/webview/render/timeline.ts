/** Pure helpers for the transcript layout: the tool-run timeline and stable row keys. */
import type { TranscriptItem } from "../../protocol/chat-frames";

export type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

export function keyOf(item: TranscriptItem, index: number): string {
  return `${item.kind}:${item.id ?? `#${index}`}`;
}

export type DisplayEntry =
  | { type: "item"; key: string; item: TranscriptItem }
  | { type: "timeline"; key: string; tools: ToolItem[] };

/**
 * Display order. Every tool item of a turn (the span after a user item, up to the next one) is gathered into ONE
 * timeline entry placed right after the user item and before the other rows of that turn. The history order is
 * user, tools, assistant; live streaming may deliver the tools after the assistant row, so this is reordered here.
 * The timeline key derives from the user item, so it stays stable while tools are added.
 */
export function groupTimeline(items: readonly TranscriptItem[]): DisplayEntry[] {
  const out: DisplayEntry[] = [];
  let turn: DisplayEntry[] = [];
  let tools: ToolItem[] = [];
  let anchor = "start";

  const flush = (): void => {
    if (tools.length > 0) out.push({ type: "timeline", key: `timeline:${anchor}`, tools });
    out.push(...turn);
    turn = [];
    tools = [];
  };

  items.forEach((item, i) => {
    const key = keyOf(item, i);
    if (item.kind === "user") {
      flush();
      out.push({ type: "item", key, item });
      anchor = key;
    } else if (item.kind === "tool") {
      tools.push(item);
    } else {
      turn.push({ type: "item", key, item });
    }
  });
  flush();
  return out;
}

/** Consecutive calls of one tool this long are folded into a single "Read file · 4" row. */
export const GROUP_MIN = 3;

export type TimelineSlot = { group: false; tool: ToolItem } | { group: true; key: string; tools: ToolItem[] };

/** Splits the calls into slots: a run of GROUP_MIN or more calls of the same tool becomes one group slot. */
export function foldRuns(tools: readonly ToolItem[]): TimelineSlot[] {
  const out: TimelineSlot[] = [];
  let i = 0;
  while (i < tools.length) {
    let j = i + 1;
    while (j < tools.length && tools[j].tool === tools[i].tool) j++;
    if (j - i >= GROUP_MIN) out.push({ group: true, key: `group:${tools[i].id}`, tools: tools.slice(i, j) });
    else for (let k = i; k < j; k++) out.push({ group: false, tool: tools[k] });
    i = j;
  }
  return out;
}
