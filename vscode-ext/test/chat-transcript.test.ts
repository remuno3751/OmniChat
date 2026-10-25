import { describe, expect, it } from "vitest";
import { applyTranscript, applyTranscriptChecked, isRunning, MAX_ITEMS, toolLabel } from "../src/chat/transcript";
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

describe("applyTranscriptChecked deltas", () => {
  const streamed = (text: string, reasoning?: string): TranscriptItem[] => [
    { kind: "assistant", id: "a1", text, status: "streaming", ...(reasoning !== undefined ? { reasoning } : {}) },
  ];

  it("appends the suffix when from matches the stored text length", () => {
    const start = applyTranscriptChecked([], frame(streamed("He")));
    expect(start.stale).toBe(false);
    const next = applyTranscriptChecked(
      start.items,
      frame([{ kind: "assistant", id: "a1", text: "llo", from: 2, status: "streaming" }]),
    );
    expect(next.stale).toBe(false);
    expect(next.items).toEqual([{ kind: "assistant", id: "a1", text: "Hello", status: "streaming" }]);
  });

  it("appends reasoning with reasoningFrom and keeps text when only reasoning is a delta", () => {
    const start = applyTranscriptChecked([], frame(streamed("A", "th")));
    const next = applyTranscriptChecked(
      start.items,
      frame([{ kind: "assistant", id: "a1", text: "B", from: 1, reasoning: "ink", reasoningFrom: 2, status: "streaming" }]),
    );
    expect(next.stale).toBe(false);
    expect(next.items[0]).toEqual({ kind: "assistant", id: "a1", text: "AB", reasoning: "think", status: "streaming" });
  });

  it("treats a missing reasoning as empty for reasoningFrom 0", () => {
    const start = applyTranscriptChecked([], frame(streamed("A")));
    const next = applyTranscriptChecked(
      start.items,
      frame([{ kind: "assistant", id: "a1", text: "", from: 1, reasoning: "hm", reasoningFrom: 0, status: "streaming" }]),
    );
    expect(next.stale).toBe(false);
    expect(next.items[0]).toMatchObject({ text: "A", reasoning: "hm" });
  });

  it("never stores from or reasoningFrom", () => {
    const start = applyTranscriptChecked([], frame(streamed("A")));
    const next = applyTranscriptChecked(
      start.items,
      frame([{ kind: "assistant", id: "a1", text: "B", from: 1, reasoningFrom: 0, reasoning: "r", status: "streaming" }]),
    );
    const stored = next.items[0] as Record<string, unknown>;
    expect(stored).not.toHaveProperty("from");
    expect(stored).not.toHaveProperty("reasoningFrom");
    expect(stored).toMatchObject({ text: "AB", reasoning: "r" });
  });

  it("flags a mismatch as stale and keeps the stored item unchanged", () => {
    const start = applyTranscriptChecked([], frame(streamed("He")));
    const bad = applyTranscriptChecked(
      start.items,
      frame([{ kind: "assistant", id: "a1", text: "xx", from: 5, status: "streaming" }]),
    );
    expect(bad.stale).toBe(true);
    expect(bad.items).toEqual(start.items);
    expect(bad.items).not.toBe(start.items);
  });

  it("flags a reasoning mismatch as stale even when the text would match", () => {
    const start = applyTranscriptChecked([], frame(streamed("A", "x")));
    const bad = applyTranscriptChecked(
      start.items,
      frame([{ kind: "assistant", id: "a1", text: "B", from: 1, reasoning: "y", reasoningFrom: 3, status: "streaming" }]),
    );
    expect(bad.stale).toBe(true);
    expect(bad.items).toEqual(start.items);
  });

  it("flags a delta for an unknown item and does not add it", () => {
    const out = applyTranscriptChecked([], frame([{ kind: "assistant", id: "a9", text: "x", from: 0, status: "streaming" }]));
    expect(out.stale).toBe(true);
    expect(out.items).toEqual([]);
  });

  it("flags a delta that targets a non-assistant item", () => {
    const start = applyTranscriptChecked([], frame([{ kind: "user", id: "a1", text: "hi" }]));
    const out = applyTranscriptChecked(start.items, frame([{ kind: "assistant", id: "a1", text: "x", from: 2, status: "streaming" }]));
    expect(out.stale).toBe(true);
    expect(out.items).toEqual(start.items);
  });

  it("applies the other items of a frame when one delta is stale", () => {
    const out = applyTranscriptChecked(
      [],
      frame([
        { kind: "assistant", id: "a1", text: "x", from: 3, status: "streaming" },
        { kind: "user", id: "u1", text: "hi" },
      ]),
    );
    expect(out.stale).toBe(true);
    expect(out.items.map((i) => i.id)).toEqual(["u1"]);
  });

  it("a final full frame replaces the streamed text and clears stale state", () => {
    const start = applyTranscriptChecked([], frame(streamed("He")));
    const stale = applyTranscriptChecked(start.items, frame([{ kind: "assistant", id: "a1", text: "x", from: 9, status: "streaming" }]));
    const done = applyTranscriptChecked(
      stale.items,
      frame([{ kind: "assistant", id: "a1", text: "Hello world", status: "done" }]),
    );
    expect(done.stale).toBe(false);
    expect(done.items).toEqual([{ kind: "assistant", id: "a1", text: "Hello world", status: "done" }]);
  });

  it("a reset frame starts from nothing, so deltas in it are stale", () => {
    const start = applyTranscriptChecked([], frame(streamed("He")));
    const out = applyTranscriptChecked(
      start.items,
      frame([{ kind: "assistant", id: "a1", text: "llo", from: 2, status: "streaming" }], { reset: true }),
    );
    expect(out.stale).toBe(true);
    expect(out.items).toEqual([]);
  });

  it("applyTranscript returns the same items as the checked variant", () => {
    const start = applyTranscript([], frame(streamed("He")));
    const f = frame([{ kind: "assistant", id: "a1", text: "y", from: 2, status: "streaming" }]);
    expect(applyTranscript(start, f)).toEqual(applyTranscriptChecked(start, f).items);
  });
});

describe("delta keeps reasoning", () => {
  it("a text-only delta does not drop the stored reasoning", () => {
    const base = { kind: "assistant", id: "a", text: "ab", reasoning: "think", status: "streaming" } as const;
    const r = applyTranscriptChecked([base], { type: "transcript", conversationId: "c", items: [{ kind: "assistant", id: "a", text: "cd", from: 2, status: "streaming" }] });
    expect(r.stale).toBe(false);
    expect(r.items[0]).toMatchObject({ text: "abcd", reasoning: "think" });
  });
});
