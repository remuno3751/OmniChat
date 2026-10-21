import { describe, expect, it } from "vitest";
import { createChatController } from "../src/chat/controller";
import type { Frame } from "../src/protocol/frames";

/** A controller wired to a list of sent frames, with two saved conversations. */
function setupHistory() {
  const sent: Frame[] = [];
  const c = createChatController({
    send: (f) => {
      sent.push(f);
      return true;
    },
    roots: () => ["/work/app"],
    onChange: () => undefined,
  });
  c.setOnline(true);
  c.handleFrame({ type: "models", requestId: "m", items: [{ ref: "p::a", label: "A", provider: "P" }] });
  c.handleFrame({
    type: "conversations",
    requestId: "l",
    items: [
      { id: "old", title: "Old chat", updatedAt: 10, approvalMode: "manual", cwd: "/work/app" },
      { id: "new", title: "New chat", updatedAt: 20, approvalMode: "auto", cwd: "/work/app" },
    ],
  });
  sent.length = 0;
  return { c, sent };
}

describe("chat history", () => {
  it("opens a saved conversation, then continues it with the next prompt", () => {
    const { c, sent } = setupHistory();
    c.openConversation("old");
    expect(sent.map((f) => f.type)).toEqual(["conversation_request"]);
    expect(c.snapshot().loadingConversation).toBe(true);
    expect(c.snapshot().conversationId).toBe("old");

    c.handleFrame({
      type: "transcript",
      conversationId: "old",
      reset: true,
      items: [
        { kind: "user", id: "u1", text: "first" },
        { kind: "assistant", id: "a1", text: "reply", status: "done" },
      ],
    });
    expect(c.snapshot().loadingConversation).toBe(false);
    expect(c.snapshot().items).toHaveLength(2);

    sent.length = 0;
    c.sendPrompt("second");
    expect(sent[0]).toMatchObject({ type: "prompt", conversationId: "old", approvalMode: "manual", model: "p::a" });
  });

  it("keeps a conversation's cached items when it is opened again", () => {
    const { c } = setupHistory();
    c.openConversation("old");
    c.handleFrame({
      type: "transcript",
      conversationId: "old",
      reset: true,
      items: [{ kind: "user", id: "u1", text: "first" }],
    });
    c.openConversation("new");
    expect(c.snapshot().items).toEqual([]);
    c.openConversation("old");
    expect(c.snapshot().items).toHaveLength(1);
    expect(c.snapshot().loadingConversation).toBe(true);
  });

  it("starts a fresh chat without an id, and the list keeps the saved conversations", () => {
    const { c, sent } = setupHistory();
    c.openConversation("new");
    c.newConversation();
    expect(c.snapshot().conversationId).toBeNull();
    expect(c.snapshot().items).toEqual([]);
    expect(c.snapshot().conversations.map((x) => x.id)).toEqual(["new", "old"]);
    sent.length = 0;
    c.sendPrompt("hello");
    expect(sent[0]).not.toHaveProperty("conversationId");
  });

  it("re-reads the open conversation on refresh", () => {
    const { c, sent } = setupHistory();
    c.openConversation("old");
    sent.length = 0;
    c.refresh();
    expect(sent.map((f) => f.type)).toEqual(["models_request", "conversations_request", "conversation_request"]);
  });

  it("reports a conversation the server no longer has", () => {
    const { c, sent } = setupHistory();
    c.openConversation("gone");
    const request = sent[sent.length - 1] as { requestId: string };
    c.handleFrame({ type: "error", code: "not_found", requestId: request.requestId });
    expect(c.snapshot().loadingConversation).toBe(false);
    expect(c.snapshot().error).toEqual({ code: "not_found" });
  });
});
