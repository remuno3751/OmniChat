import { describe, expect, it } from "vitest";
import { applyTranscript, isRunning, MAX_ITEMS, toolLabel } from "../src/chat/transcript";
import type { TranscriptFrame, TranscriptItem } from "../src/protocol/chat-frames";

const frame = (items: TranscriptItem[], extra: Partial<TranscriptFrame> = {}): TranscriptFrame => ({
  type: "transcript",
  conversationId: "c1",
  items,
  ...extra,
});

describe("applyTranscript", () => {
  it("appends new items in order", () => {
    const a = applyTranscript([], frame([{ kind: "user", id: "m1", text: "hi" }]));
    const b = applyTranscript(a, frame([{ kind: "assistant", id: "m2", text: "", status: "streaming" }]));
    expect(b.map((i) => i.id)).toEqual(["m1", "m2"]);
  });

  it("replaces a streaming item by id, in place", () => {
    let items = applyTranscript([], frame([{ kind: "user", id: "m1", text: "hi" }]));
    items = applyTranscript(items, frame([{ kind: "assistant", id: "m2", text: "He", status: "streaming" }]));
    items = applyTranscript(items, frame([{ kind: "assistant", id: "m2", text: "Hello", status: "streaming" }]));
    items = applyTranscript(items, frame([{ kind: "tool", id: "k1", tool: "grep", summary: "x", status: "running" }]));
    items = applyTranscript(items, frame([{ kind: "assistant", id: "m2", text: "Hello!", status: "done" }]));
    expect(items).toHaveLength(3);
    expect(items[1]).toMatchObject({ id: "m2", text: "Hello!", status: "done" });
  });

  it("follows tool status changes", () => {
    let items = applyTranscript(
      [],
      frame([{ kind: "tool", id: "k1", tool: "edit_file", summary: "a.ts", status: "pending" }]),
    );
    expect(isRunning(items)).toBe(true);
    items = applyTranscript(items, frame([{ kind: "tool", id: "k1", tool: "edit_file", summary: "a.ts", status: "running" }]));
    expect(isRunning(items)).toBe(true);
    items = applyTranscript(
      items,
      frame([{ kind: "tool", id: "k1", tool: "edit_file", summary: "a.ts", status: "done", durationMs: 5, decidedBy: "user" }]),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: "done", durationMs: 5, decidedBy: "user" });
    expect(isRunning(items)).toBe(false);
  });

  it("reset replaces the whole transcript", () => {
    const old = applyTranscript([], frame([{ kind: "user", id: "m1", text: "old" }]));
    const next = applyTranscript(old, frame([{ kind: "user", id: "n1", text: "new" }], { reset: true }));
    expect(next.map((i) => i.id)).toEqual(["n1"]);
  });

  it("keeps id-less status items as separate rows", () => {
    let items = applyTranscript([], frame([{ kind: "status", text: "a" }]));
    items = applyTranscript(items, frame([{ kind: "status", text: "a" }]));
    expect(items).toHaveLength(2);
  });

  it("does not mutate its input and bounds the list", () => {
    const input: TranscriptItem[] = [{ kind: "user", id: "m1", text: "x" }];
    applyTranscript(input, frame([{ kind: "user", id: "m1", text: "y" }]));
    expect(input[0]).toMatchObject({ text: "x" });
    const many = Array.from(
      { length: MAX_ITEMS + 5 },
      (_, i): TranscriptItem => ({ kind: "user", id: `u${i}`, text: "" }),
    );
    const out = applyTranscript([], frame(many));
    expect(out).toHaveLength(MAX_ITEMS);
    expect(out[out.length - 1]?.id).toBe(`u${MAX_ITEMS + 4}`);
  });

  it("labels tools", () => {
    expect(toolLabel({ kind: "tool", id: "k", tool: "grep", summary: "foo", status: "done" })).toBe("grep  foo");
    expect(toolLabel({ kind: "tool", id: "k", tool: "grep", summary: "", status: "done" })).toBe("grep");
  });
});
