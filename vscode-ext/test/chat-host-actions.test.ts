import { describe, expect, it } from "vitest";
import { interruptQueued, precedingUserText, regenerateItem, type ActionController } from "../src/chat/actions";
import type { ChatSnapshot } from "../src/chat/controllerTypes";
import type { TranscriptItem } from "../src/protocol/chat-frames";

/** A controller double: a snapshot the test controls, and the calls the action makes. */
function fakeController(over: Partial<ChatSnapshot> = {}, sendOk = true) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const snap = {
    online: true,
    items: [],
    queue: [],
    busy: false,
    running: false,
    sending: false,
    ...over,
  } as unknown as ChatSnapshot;
  const c: ActionController = {
    snapshot: () => snap,
    cancelQueued: (id) => void calls.push({ op: "cancelQueued", args: [id] }),
    sendPrompt: (text, o) => (calls.push({ op: "sendPrompt", args: [text, o] }), sendOk),
  };
  return { c, calls };
}

const ITEMS: TranscriptItem[] = [
  { kind: "user", id: "u1", text: "first question" },
  { kind: "assistant", id: "a1", text: "first answer", status: "done" },
  { kind: "tool", id: "t1", tool: "read_file", summary: "a.ts", status: "done" },
  { kind: "user", id: "u2", text: "second question" },
  { kind: "status", text: "stopped" },
  { kind: "assistant", id: "a2", text: "second answer", status: "done" },
];

describe("interruptQueued", () => {
  it("sends the queued text with interrupt, then removes that entry", () => {
    const { c, calls } = fakeController({ queue: [{ id: "q1", text: "next" }, { id: "q2", text: "later" }] });
    expect(interruptQueued(c, "q2")).toBe(true);
    expect(calls).toEqual([
      { op: "sendPrompt", args: ["later", { interrupt: true }] },
      { op: "cancelQueued", args: ["q2"] },
    ]);
  });

  it("does nothing for an unknown id", () => {
    const { c, calls } = fakeController({ queue: [{ id: "q1", text: "next" }] });
    expect(interruptQueued(c, "nope")).toBe(false);
    expect(calls).toEqual([]);
  });

  it("keeps the entry queued when the send is refused", () => {
    const { c, calls } = fakeController({ queue: [{ id: "q1", text: "next" }] }, false);
    expect(interruptQueued(c, "q1")).toBe(false);
    expect(calls.map((x) => x.op)).toEqual(["sendPrompt"]);
  });
});

describe("precedingUserText", () => {
  it("takes the nearest user item before the index, skipping tool and status items", () => {
    expect(precedingUserText(ITEMS, 5)).toBe("second question");
    expect(precedingUserText(ITEMS, 2)).toBe("first question");
  });

  it("is null when no user item comes before the index", () => {
    expect(precedingUserText(ITEMS, 0)).toBeNull();
    expect(precedingUserText([{ kind: "assistant", id: "a", text: "", status: "done" }], 0)).toBeNull();
  });
});

describe("regenerateItem", () => {
  it("re-sends the user text before the assistant item as a normal prompt", () => {
    const { c, calls } = fakeController({ items: ITEMS });
    expect(regenerateItem(c, "a2")).toBe("sent");
    expect(calls).toEqual([{ op: "sendPrompt", args: ["second question", undefined] }]);
  });

  it("refuses with busy while a run is active or a prompt is in flight", () => {
    for (const over of [{ busy: true, running: true }, { busy: true, sending: true }]) {
      const { c, calls } = fakeController({ items: ITEMS, ...over });
      expect(regenerateItem(c, "a2")).toBe("busy");
      expect(calls).toEqual([]);
    }
  });

  it("reports missing for an unknown id, a non-assistant id, or an assistant with no user before it", () => {
    const { c, calls } = fakeController({ items: ITEMS });
    expect(regenerateItem(c, "zzz")).toBe("missing");
    expect(regenerateItem(c, "u1")).toBe("missing");
    const orphan = fakeController({ items: [{ kind: "assistant", id: "a0", text: "", status: "done" }] });
    expect(regenerateItem(orphan.c, "a0")).toBe("missing");
    expect(calls).toEqual([]);
  });

  it("reports refused when the send is not taken", () => {
    const { c } = fakeController({ items: ITEMS }, false);
    expect(regenerateItem(c, "a1")).toBe("refused");
  });
});
