import { describe, expect, it } from "vitest";
import { appendDraft, canRegenerate, lastAssistant, type ActionItem } from "../src/webview/chat/messageActions";

describe("appendDraft", () => {
  it("writes the prompt alone into an empty composer", () => {
    expect(appendDraft("", "next")).toBe("next");
    expect(appendDraft("   ", "next")).toBe("next");
  });

  it("appends after a newline when the composer already has text", () => {
    expect(appendDraft("draft", "next")).toBe("draft\nnext");
    expect(appendDraft("a\nb", "c\nd")).toBe("a\nb\nc\nd");
  });
});

describe("lastAssistant and canRegenerate", () => {
  const items: ActionItem[] = [
    { id: "u1", kind: "user" },
    { id: "a1", kind: "assistant", status: "done" },
    { id: "u2", kind: "user" },
    { id: "s1", kind: "status" },
  ];

  it("finds the last assistant item even when other items follow it", () => {
    expect(lastAssistant(items)?.id).toBe("a1");
    expect(lastAssistant([{ id: "u", kind: "user" }])).toBeNull();
  });

  it("allows regenerate on the last finished assistant message only", () => {
    expect(canRegenerate(items, "a1", false)).toBe(true);
    expect(canRegenerate(items, "a0", false)).toBe(false);
  });

  it("refuses regenerate while a run is active or the reply is still streaming", () => {
    expect(canRegenerate(items, "a1", true)).toBe(false);
    const streaming: ActionItem[] = [{ id: "a1", kind: "assistant", status: "streaming" }];
    expect(canRegenerate(streaming, "a1", false)).toBe(false);
  });

  it("accepts error and stopped as finished", () => {
    expect(canRegenerate([{ id: "a", kind: "assistant", status: "error" }], "a", false)).toBe(true);
    expect(canRegenerate([{ id: "a", kind: "assistant", status: "stopped" }], "a", false)).toBe(true);
  });
});
