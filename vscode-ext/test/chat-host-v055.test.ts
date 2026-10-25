import { describe, expect, it } from "vitest";
import { createChatController } from "../src/chat/controller";
import { buildExtras, visionOf } from "../src/chat/extrasModel";
import { buildChatState, parseChatMessage } from "../src/chat/viewModel";
import { stringsFor } from "../src/ui/strings";
import type { Frame } from "../src/protocol/frames";

const FILE = { name: "a.txt", mime: "text/plain", data: "aGk=" };

describe("parseChatMessage: v0.5.5-beta.2 messages", () => {
  it("accepts send and sendInterrupt with attachments, and without them", () => {
    expect(parseChatMessage({ type: "send", text: "hi", attachments: [FILE] })).toEqual({ type: "send", text: "hi", attachments: [FILE] });
    expect(parseChatMessage({ type: "sendInterrupt", text: "hi", attachments: [FILE] })).toEqual({
      type: "sendInterrupt",
      text: "hi",
      attachments: [FILE],
    });
    expect(parseChatMessage({ type: "send", text: "hi", attachments: [] })).toEqual({ type: "send", text: "hi" });
    expect(parseChatMessage({ type: "send", text: "hi" })).toEqual({ type: "send", text: "hi" });
  });

  it("rejects send with malformed attachments", () => {
    expect(parseChatMessage({ type: "send", text: "hi", attachments: "x" })).toBeNull();
    expect(parseChatMessage({ type: "send", text: "hi", attachments: [{ name: "a", mime: "text/plain" }] })).toBeNull();
    expect(parseChatMessage({ type: "sendInterrupt", text: "hi", attachments: [{ ...FILE, data: "%%" }] })).toBeNull();
  });

  it("accepts slash for the three host commands only", () => {
    for (const name of ["clear", "context", "compact"]) {
      expect(parseChatMessage({ type: "slash", name })).toEqual({ type: "slash", name });
    }
    expect(parseChatMessage({ type: "slash", name: "model" })).toBeNull();
    expect(parseChatMessage({ type: "slash", name: "help" })).toBeNull();
    expect(parseChatMessage({ type: "slash" })).toBeNull();
  });

  it("accepts requestDevices", () => {
    expect(parseChatMessage({ type: "requestDevices" })).toEqual({ type: "requestDevices" });
  });

  it("accepts toggleFavorite for a device or a folder, and rejects other kinds and empty keys", () => {
    expect(parseChatMessage({ type: "toggleFavorite", kind: "device", key: "work-pc" })).toEqual({
      type: "toggleFavorite",
      kind: "device",
      key: "work-pc",
    });
    expect(parseChatMessage({ type: "toggleFavorite", kind: "folder", key: "/work/app" })).toEqual({
      type: "toggleFavorite",
      kind: "folder",
      key: "/work/app",
    });
    expect(parseChatMessage({ type: "toggleFavorite", kind: "file", key: "x" })).toBeNull();
    expect(parseChatMessage({ type: "toggleFavorite", kind: "folder", key: "" })).toBeNull();
  });
});

describe("extras in the view state", () => {
  function snapshotWith(models: Array<{ ref: string; label: string; provider: string; vision?: "yes" | "no" | "unknown" }>) {
    const frames: Frame[] = [];
    const c = createChatController({ send: (f) => (frames.push(f), true), roots: () => ["/work/app"], onChange: () => undefined });
    c.setOnline(true);
    c.handleFrame({ type: "models", requestId: "m0", items: models });
    return c.snapshot();
  }

  it("builds the slash menu, the limits and the favourites in the view state", () => {
    const snap = snapshotWith([{ ref: "p::a", label: "A", provider: "P", vision: "yes" }]);
    const state = buildChatState({
      lang: "en",
      paired: true,
      status: "online",
      snapshot: snap,
      approvals: [],
      favorites: { devices: ["work-pc"], folders: [] },
    });
    expect(state.extras.slash.map((s) => s.name)).toEqual([
      "clear",
      "context",
      "model",
      "help",
      "compact",
      "usage",
      "retry",
      "pin",
      "export",
      "effort",
      "rename",
      "export",
    ]);
    expect(state.extras.slash[0].desc).toBe(stringsFor("en").slashClear);
    expect(state.extras.attach).toMatchObject({ maxFiles: 4, maxFileBytes: 4 * 1024 * 1024, maxTotalBytes: 5 * 1024 * 1024, visionOk: true });
    expect(state.extras.attach.imageMimes).toContain("image/png");
    expect(state.extras.favorites).toEqual({ devices: ["work-pc"], folders: [] });
    expect(state.extras.devices).toEqual({ state: "idle", items: [] });
  });

  it("reads vision of the effective model, and null when it is unknown", () => {
    expect(visionOf(snapshotWith([{ ref: "p::a", label: "A", provider: "P", vision: "no" }]))).toBe(false);
    expect(visionOf(snapshotWith([{ ref: "p::a", label: "A", provider: "P", vision: "unknown" }]))).toBeNull();
    expect(visionOf(snapshotWith([{ ref: "p::a", label: "A", provider: "P" }]))).toBeNull();
    expect(visionOf(snapshotWith([]))).toBeNull();
  });

  it("gives empty favourites when none are passed", () => {
    const snap = snapshotWith([]);
    const extras = buildExtras({ strings: stringsFor("en"), snapshot: snap, favorites: { devices: [], folders: [] } });
    expect(extras.favorites).toEqual({ devices: [], folders: [] });
  });

  it("shows the attachment wording for attachment errors", () => {
    const en = stringsFor("en");
    const snap = snapshotWith([]);
    const withError = { ...snap, error: { code: "attachment_too_large" as const } };
    const state = buildChatState({ lang: "en", paired: true, status: "online", snapshot: withError, approvals: [] });
    expect(state.errorText).toBe(en.errAttachTooLarge);
    const invalid = buildChatState({
      lang: "en",
      paired: true,
      status: "online",
      snapshot: { ...snap, error: { code: "attachment_not_supported" as const } },
      approvals: [],
    });
    expect(invalid.errorText).toBe(en.errAttachNotSupported);
  });
});
