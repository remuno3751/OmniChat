import { describe, expect, it } from "vitest";
import { detectPath } from "../src/webview/render/paths";
import { groupTimeline } from "../src/webview/render/timeline";
import { createThinkingModel } from "../src/webview/render/thinking";
import type { TranscriptItem } from "../src/protocol/chat-frames";

describe("detectPath", () => {
  it("accepts workspace-relative and absolute paths", () => {
    expect(detectPath("src/a/b.ts")).toEqual({ path: "src/a/b.ts" });
    expect(detectPath("./x.md")).toEqual({ path: "./x.md" });
    expect(detectPath("../up/y.json")).toEqual({ path: "../up/y.json" });
    expect(detectPath("package.json")).toEqual({ path: "package.json" });
    expect(detectPath("C:\\Users\\a\\b.ts")).toEqual({ path: "C:\\Users\\a\\b.ts" });
    expect(detectPath("C:/proj/src")).toEqual({ path: "C:/proj/src" });
    expect(detectPath("/usr/bin/foo.sh")).toEqual({ path: "/usr/bin/foo.sh" });
  });
  it("reads an optional line", () => {
    expect(detectPath("src/a.ts:42")).toEqual({ path: "src/a.ts", line: 42 });
    expect(detectPath("src/a.ts:42:7")).toEqual({ path: "src/a.ts", line: 42 });
  });
  it("rejects urls, versions, words and prose", () => {
    for (const t of [
      "https://example.com/a.ts", "http://x/y", "www.example.com", "mailto:a@b.c", "vscode://file/a.ts",
      "1.2.3", "v1.2.3", "0.5.5", "e.g.", "hello", "and/or", "read/write", "Node.js", "a b.ts", "", "src/utils",
      "foo?.ts", "a//b.ts", "3.14", "key:12", "/",
    ]) {
      expect(detectPath(t), t).toBeNull();
    }
  });
});

const user = (id: string): TranscriptItem => ({ kind: "user", id, text: id });
const asst = (id: string): TranscriptItem => ({ kind: "assistant", id, text: id, status: "done" });
const tool = (id: string): TranscriptItem => ({ kind: "tool", id, tool: "glob", summary: "", status: "done" });

describe("groupTimeline", () => {
  it("places one timeline after the user row and before the assistant row", () => {
    const out = groupTimeline([user("u1"), tool("t1"), tool("t2"), asst("a1")]);
    expect(out.map((e) => e.type)).toEqual(["item", "timeline", "item"]);
    const tl = out[1];
    expect(tl.type === "timeline" && tl.tools.map((t) => t.id)).toEqual(["t1", "t2"]);
  });
  it("moves tools that arrive after the assistant row above it", () => {
    const out = groupTimeline([user("u1"), asst("a1"), tool("t1")]);
    expect(out.map((e) => e.key)).toEqual(["user:u1", "timeline:user:u1", "assistant:a1"]);
  });
  it("keeps one timeline per turn and a stable key", () => {
    const a = groupTimeline([user("u1"), tool("t1"), asst("a1"), user("u2"), tool("t2"), asst("a2")]);
    expect(a.filter((e) => e.type === "timeline").map((e) => e.key)).toEqual(["timeline:user:u1", "timeline:user:u2"]);
    const b = groupTimeline([user("u1"), tool("t1"), tool("t9")]);
    expect(b[1].key).toBe("timeline:user:u1");
  });
  it("handles no tools and tools before any user row", () => {
    expect(groupTimeline([user("u1"), asst("a1")]).some((e) => e.type === "timeline")).toBe(false);
    expect(groupTimeline([tool("t1"), asst("a1")]).map((e) => e.key)).toEqual(["timeline:start", "assistant:a1"]);
  });
});

describe("thinking model", () => {
  it("is live only while streaming without answer text and starts closed", () => {
    const m = createThinkingModel();
    expect(m.update({ streaming: true, hasText: false })).toEqual({ live: true, forceOpen: false });
    expect(m.update({ streaming: true, hasText: true })).toEqual({ live: false, forceOpen: false });
  });
  it("keeps the open state once the user toggled, also after streaming ends", () => {
    const m = createThinkingModel();
    m.update({ streaming: true, hasText: false });
    m.userToggled();
    expect(m.update({ streaming: true, hasText: true }).forceOpen).toBeNull();
    expect(m.update({ streaming: false, hasText: true })).toEqual({ live: false, forceOpen: null });
  });
});
