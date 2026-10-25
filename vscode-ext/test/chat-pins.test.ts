import { describe, expect, it, vi } from "vitest";
import { readPins, pinFirst, togglePin, PINS_KEY, MAX_PINS } from "../src/chat/pins";
import type { MementoLike } from "../src/chat/favorites";

function memento(init: Record<string, unknown> = {}): MementoLike & { data: Map<string, unknown> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    get: <T>(key: string, def: T) => (data.has(key) ? (data.get(key) as T) : def),
    update: vi.fn(async (key: string, value: unknown) => {
      data.set(key, value);
    }),
  };
}

describe("pinned conversations", () => {
  it("uses the omnichat.pinnedConversations key and reads an empty list by default", () => {
    expect(PINS_KEY).toBe("omnichat.pinnedConversations");
    expect(readPins(memento())).toEqual([]);
  });

  it("reads only non-empty strings and treats a broken value as empty", () => {
    expect(readPins(memento({ [PINS_KEY]: ["c1", "", 3, "c2"] }))).toEqual(["c1", "c2"]);
    expect(readPins(memento({ [PINS_KEY]: "c1" }))).toEqual([]);
    const broken: MementoLike = {
      get: () => {
        throw new Error("corrupt");
      },
      update: async () => undefined,
    };
    expect(readPins(broken)).toEqual([]);
  });

  it("toggles a pin on and off, storing the list", async () => {
    const m = memento();
    expect(await togglePin(m, "c1")).toEqual(["c1"]);
    expect(await togglePin(m, "c2")).toEqual(["c1", "c2"]);
    expect(await togglePin(m, "c1")).toEqual(["c2"]);
    expect(m.data.get(PINS_KEY)).toEqual(["c2"]);
  });

  it("keeps the newest pins when the list is full", async () => {
    const full = Array.from({ length: MAX_PINS }, (_v, i) => `old${i}`);
    const next = await togglePin(memento({ [PINS_KEY]: full }), "new");
    expect(next).toHaveLength(MAX_PINS);
    expect(next.at(-1)).toBe("new");
    expect(next[0]).toBe("old1");
  });

  it("returns the list even when the write fails", async () => {
    const m: MementoLike = {
      get: <T>(_k: string, d: T) => d,
      update: async () => {
        throw new Error("read-only");
      },
    };
    expect(await togglePin(m, "c1")).toEqual(["c1"]);
  });

  it("puts pinned items first, keeps each group in order, and flags them", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    expect(pinFirst(items, ["c", "a"])).toEqual([
      { id: "a", pinned: true },
      { id: "c", pinned: true },
      { id: "b", pinned: false },
      { id: "d", pinned: false },
    ]);
    expect(pinFirst(items, [])).toEqual(items.map((i) => ({ ...i, pinned: false })));
  });
});
