import { describe, expect, it } from "vitest";
import { parseChatMessage } from "../src/chat/viewModel";

describe("parseChatMessage: queue, regenerate and editor messages", () => {
  it("accepts interruptQueued and cancelQueued with an id", () => {
    expect(parseChatMessage({ type: "interruptQueued", id: "q3" })).toEqual({ type: "interruptQueued", id: "q3" });
    expect(parseChatMessage({ type: "cancelQueued", id: "q3" })).toEqual({ type: "cancelQueued", id: "q3" });
  });

  it("rejects interruptQueued without a usable id", () => {
    expect(parseChatMessage({ type: "interruptQueued" })).toBeNull();
    expect(parseChatMessage({ type: "interruptQueued", id: "" })).toBeNull();
    expect(parseChatMessage({ type: "interruptQueued", id: 3 })).toBeNull();
    expect(parseChatMessage({ type: "interruptQueued", id: "x".repeat(65) })).toBeNull();
  });

  it("accepts regenerate with an assistant item id, and rejects a missing or oversized one", () => {
    expect(parseChatMessage({ type: "regenerate", id: "a12" })).toEqual({ type: "regenerate", id: "a12" });
    expect(parseChatMessage({ type: "regenerate", id: "x".repeat(256) })).toEqual({ type: "regenerate", id: "x".repeat(256) });
    expect(parseChatMessage({ type: "regenerate" })).toBeNull();
    expect(parseChatMessage({ type: "regenerate", id: "x".repeat(257) })).toBeNull();
    expect(parseChatMessage({ type: "regenerate", id: null })).toBeNull();
  });

  it("accepts openInEditor with no fields", () => {
    expect(parseChatMessage({ type: "openInEditor" })).toEqual({ type: "openInEditor" });
  });
});
