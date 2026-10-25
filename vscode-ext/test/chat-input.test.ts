import { describe, expect, it } from "vitest";
import { checkAttachment, fillTemplate, formatSize, limitMb, MIB } from "../src/webview/chat/attachLogic";
import { filterSlash, helpText, slashAction, slashQuery } from "../src/webview/chat/slashLogic";
import { DEFAULT_ATTACH, type AttachLimitsView, type SlashEntry } from "../src/webview/chat/types";

const ENTRIES: SlashEntry[] = [
  { name: "clear", desc: "Start a new conversation" },
  { name: "context", desc: "Show context usage" },
  { name: "model", desc: "Choose the model" },
  { name: "help", desc: "List the commands" },
  { name: "compact", desc: "Summarise the conversation" },
];

describe("slashQuery", () => {
  it("returns the typed name after a leading slash", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/co")).toBe("co");
  });

  it("is null when the text is not a command in progress", () => {
    expect(slashQuery("hello")).toBeNull();
    expect(slashQuery("a /co")).toBeNull();
    expect(slashQuery("/co ")).toBeNull();
    expect(slashQuery("/co\nx")).toBeNull();
    expect(slashQuery("/co\tx")).toBeNull();
  });
});

describe("filterSlash", () => {
  it("keeps entries whose name starts with the query, in order", () => {
    expect(filterSlash(ENTRIES, "co").map((e) => e.name)).toEqual(["context", "compact"]);
  });

  it("matches case-insensitively and an empty query lists everything", () => {
    expect(filterSlash(ENTRIES, "MO").map((e) => e.name)).toEqual(["model"]);
    expect(filterSlash(ENTRIES, "")).toHaveLength(ENTRIES.length);
  });

  it("does not match inside a name or the description", () => {
    expect(filterSlash(ENTRIES, "ext")).toEqual([]);
    expect(filterSlash(ENTRIES, "new")).toEqual([]);
  });
});

describe("slashAction and helpText", () => {
  it("sends clear, context and compact to the host, model and help stay local", () => {
    expect(slashAction("clear")).toEqual({ kind: "host", name: "clear" });
    expect(slashAction("context")).toEqual({ kind: "host", name: "context" });
    expect(slashAction("compact")).toEqual({ kind: "host", name: "compact" });
    expect(slashAction("model")).toEqual({ kind: "model" });
    expect(slashAction("help")).toEqual({ kind: "help" });
  });

  it("lists every command on its own line", () => {
    expect(helpText(ENTRIES.slice(0, 2))).toBe("/clear - Start a new conversation\n/context - Show context usage");
  });
});

describe("formatSize", () => {
  it("uses B, KB and MB with one decimal from KB up", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(MIB)).toBe("1.0 MB");
    expect(formatSize(4 * MIB)).toBe("4.0 MB");
  });

  it("guards against bad numbers", () => {
    expect(formatSize(-1)).toBe("0 B");
    expect(formatSize(Number.NaN)).toBe("0 B");
  });
});

describe("limitMb and fillTemplate", () => {
  it("prints whole MB without a decimal", () => {
    expect(limitMb(4 * MIB)).toBe("4");
    expect(limitMb(MIB / 2)).toBe("0.5");
  });

  it("fills known keys and keeps unknown ones", () => {
    expect(fillTemplate("{name} is too large (max {mb} MB each)", { name: "a.png", mb: 4 })).toBe("a.png is too large (max 4 MB each)");
    expect(fillTemplate("{x} and {y}", { x: 1 })).toBe("1 and {y}");
  });
});

describe("checkAttachment", () => {
  const limits: AttachLimitsView = { ...DEFAULT_ATTACH, visionOk: true };
  const none = { count: 0, totalBytes: 0 };

  it("accepts a document within the limits", () => {
    expect(checkAttachment({ name: "a.txt", mime: "text/plain", size: 100 }, none, limits)).toBeNull();
    expect(checkAttachment({ name: "a.bin", mime: "", size: 100 }, none, limits)).toBeNull();
  });

  it("refuses audio and video", () => {
    expect(checkAttachment({ name: "a.mp3", mime: "audio/mpeg", size: 1 }, none, limits)).toBe("badType");
    expect(checkAttachment({ name: "a.mp4", mime: "video/mp4", size: 1 }, none, limits)).toBe("badType");
  });

  it("refuses an image type the host does not list", () => {
    expect(checkAttachment({ name: "a.svg", mime: "image/svg+xml", size: 1 }, none, limits)).toBe("badType");
    expect(checkAttachment({ name: "a.png", mime: "image/png", size: 1 }, none, limits)).toBeNull();
  });

  it("refuses images when the model is known not to read them, but allows unknown", () => {
    const png = { name: "a.png", mime: "image/png", size: 1 };
    expect(checkAttachment(png, none, { ...limits, visionOk: false })).toBe("noVision");
    expect(checkAttachment(png, none, { ...limits, visionOk: null })).toBeNull();
    expect(checkAttachment({ name: "a.txt", mime: "text/plain", size: 1 }, none, { ...limits, visionOk: false })).toBeNull();
  });

  it("checks the per-file size, the count and the total", () => {
    expect(checkAttachment({ name: "big", mime: "text/plain", size: 4 * MIB + 1 }, none, limits)).toBe("tooBig");
    expect(checkAttachment({ name: "a", mime: "text/plain", size: 4 * MIB }, none, limits)).toBeNull();
    expect(checkAttachment({ name: "a", mime: "text/plain", size: 1 }, { count: 4, totalBytes: 4 }, limits)).toBe("tooMany");
    expect(checkAttachment({ name: "a", mime: "text/plain", size: 2 * MIB }, { count: 1, totalBytes: 4 * MIB }, limits)).toBe("totalBig");
    expect(checkAttachment({ name: "a", mime: "text/plain", size: MIB }, { count: 1, totalBytes: 4 * MIB }, limits)).toBeNull();
  });
});
