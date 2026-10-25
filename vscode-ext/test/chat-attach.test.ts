import { describe, expect, it, vi } from "vitest";
import { ATTACH_LIMITS, checkAttachments, decodedBytes, parseAttachments } from "../src/chat/attach";
import { readFavorites, toggleFavorite, type MementoLike } from "../src/chat/favorites";
import { compactToast, contextToast, runSlash } from "../src/chat/slash";
import type { PromptAttachment } from "../src/protocol/chat-frames";
import { inputEn } from "../src/ui/stringsInput";
import { stringsFor } from "../src/ui/strings";

const MIB = 1024 * 1024;
/** A base64 string that decodes to `bytes` bytes (the content is not checked). */
const b64 = (bytes: number): string => "A".repeat(Math.ceil((bytes * 4) / 3 / 4) * 4);
const file = (name: string, mime: string, bytes = 10): PromptAttachment => ({ name, mime, data: b64(bytes) });

describe("attachment limits", () => {
  it("decodes base64 sizes, with padding", () => {
    expect(decodedBytes("AAAA")).toBe(3);
    expect(decodedBytes("AAA=")).toBe(2);
    expect(decodedBytes("AA==")).toBe(1);
  });

  it("parses a list, treats an absent one as empty, and rejects malformed ones", () => {
    expect(parseAttachments(undefined)).toEqual([]);
    expect(parseAttachments([file("a.txt", "text/plain")])).toHaveLength(1);
    expect(parseAttachments("nope")).toBeNull();
    expect(parseAttachments([{ name: "", mime: "text/plain", data: "AAAA" }])).toBeNull();
    expect(parseAttachments([{ name: "a", mime: "text/plain", data: "not base64!" }])).toBeNull();
    expect(parseAttachments([{ name: "a", mime: "text/plain" }])).toBeNull();
    expect(parseAttachments(Array(17).fill(file("a", "text/plain")))).toBeNull();
  });

  const s = inputEn;
  it("accepts a set within the limits", () => {
    expect(checkAttachments([file("a.txt", "text/plain"), file("b.png", "image/png")], true, s)).toEqual({ ok: true });
  });

  it("refuses more files than the limit", () => {
    const list = Array(ATTACH_LIMITS.maxFiles + 1).fill(file("a.txt", "text/plain"));
    expect(checkAttachments(list, null, s)).toEqual({ ok: false, toast: "At most 4 attachments" });
  });

  it("refuses a file over the per-file limit, and names it", () => {
    const big = file("big.pdf", "application/pdf", ATTACH_LIMITS.maxFileBytes + 1);
    expect(checkAttachments([big], null, s)).toEqual({ ok: false, toast: "big.pdf is too large (max 4 MB each)" });
  });

  it("refuses a total over the limit even when each file fits", () => {
    const list = [file("a", "text/plain", 3 * MIB), file("b", "text/plain", 3 * MIB)];
    expect(checkAttachments(list, null, s)).toEqual({ ok: false, toast: "Attachments are too large in total (max 5 MB)" });
  });

  it("refuses audio and image formats the server does not take", () => {
    expect(checkAttachments([file("a.mp3", "audio/mpeg")], null, s)).toEqual({ ok: false, toast: "a.mp3 cannot be attached" });
    expect(checkAttachments([file("a.svg", "image/svg+xml")], null, s)).toEqual({ ok: false, toast: "a.svg cannot be attached" });
  });

  it("refuses an image for a model without vision, and allows it when vision is unknown", () => {
    const img = file("p.png", "image/png");
    expect(checkAttachments([img], false, s)).toEqual({ ok: false, toast: "This model cannot read images" });
    expect(checkAttachments([img], null, s)).toEqual({ ok: true });
  });
});

describe("favorites", () => {
  /** A Map-backed memento. */
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

  it("reads empty lists when nothing is stored, and keeps only strings", () => {
    expect(readFavorites(memento())).toEqual({ devices: [], folders: [] });
    const m = memento({ "omnichat.fav.devices": ["work-pc", 3, "", null], "omnichat.fav.folders": "oops" });
    expect(readFavorites(m)).toEqual({ devices: ["work-pc"], folders: [] });
  });

  it("reads empty lists when the store throws", () => {
    const m: MementoLike = {
      get: () => {
        throw new Error("broken");
      },
      update: async () => undefined,
    };
    expect(readFavorites(m)).toEqual({ devices: [], folders: [] });
  });

  it("pins a key on the first toggle and unpins it on the second, in the right list", async () => {
    const m = memento();
    expect(await toggleFavorite(m, "folder", "/work/app")).toEqual(["/work/app"]);
    expect(m.data.get("omnichat.fav.folders")).toEqual(["/work/app"]);
    expect(m.data.has("omnichat.fav.devices")).toBe(false);
    expect(await toggleFavorite(m, "folder", "/work/app")).toEqual([]);
    expect(readFavorites(m).folders).toEqual([]);
  });

  it("returns the list even when the write fails", async () => {
    const m: MementoLike = {
      get: <T>(_k: string, def: T) => def,
      update: async () => {
        throw new Error("read-only");
      },
    };
    expect(await toggleFavorite(m, "device", "work-pc")).toEqual(["work-pc"]);
  });
});

describe("slash commands on the host", () => {
  const en = stringsFor("en");
  function fake(conversationId: string | null) {
    return {
      newConversation: vi.fn(),
      refreshContext: vi.fn((cb: (u: { total: number; limit: number; fits: boolean; estimated: boolean }) => void) =>
        cb({ total: 12_300, limit: 128_000, fits: true, estimated: false }),
      ),
      compact: vi.fn((cb: (r: { ok: true; before: number; after: number } | { ok: false }) => void) =>
        cb({ ok: true, before: 90_000, after: 4_000 }),
      ),
      snapshot: () => ({ conversationId }) as never,
    };
  }

  const slashDeps = (c: object, toast: (text: string) => void) => ({
    strings: en,
    controller: c as never,
    toast,
    globalState: { get: <T>(_k: string, d: T) => d, update: async () => undefined },
    onPinsChanged: vi.fn(),
    openDocument: vi.fn(),
  });

  it("clear starts a new conversation and says nothing", () => {
    const c = fake("c1");
    const toast = vi.fn();
    runSlash("clear", slashDeps(c, toast));
    expect(c.newConversation).toHaveBeenCalledOnce();
    expect(toast).not.toHaveBeenCalled();
  });

  it("context toasts the usage", () => {
    const c = fake("c1");
    const toast = vi.fn();
    runSlash("context", slashDeps(c, toast));
    expect(toast).toHaveBeenCalledWith("Context: 12.3k / 128k (10%)");
  });

  it("compact toasts the start and then the result", () => {
    const c = fake("c1");
    const toast = vi.fn();
    runSlash("compact", slashDeps(c, toast));
    expect(toast.mock.calls.map((x) => x[0])).toEqual(["Compacting…", "Compacted (90k → 4k tokens)"]);
  });

  it("context and compact need an open conversation", () => {
    for (const name of ["context", "compact"] as const) {
      const c = fake(null);
      const toast = vi.fn();
      runSlash(name, slashDeps(c, toast));
      expect(toast).toHaveBeenCalledWith(en.slashNeedConversation);
      expect(c.compact).not.toHaveBeenCalled();
      expect(c.refreshContext).not.toHaveBeenCalled();
    }
  });

  it("formats the failure and an unknown limit", () => {
    expect(compactToast({ ok: false }, en)).toBe(en.slashCompactFail);
    expect(contextToast({ total: 500, limit: 0, fits: true, estimated: true }, en)).toBe(en.slashContextUnknown);
  });
});
