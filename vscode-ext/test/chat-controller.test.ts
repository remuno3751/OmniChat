import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatController, type ChatController } from "../src/chat/controller";
import type { Frame } from "../src/protocol/frames";

const MODEL = { ref: "p::a", label: "A", provider: "P" };

function setup(roots: string[] = ["/work/app"], timeouts: { timeoutMs?: number; promptAckTimeoutMs?: number } = {}) {
  const sent: Frame[] = [];
  const c: ChatController = createChatController({
    send: (f) => {
      sent.push(f);
      return true;
    },
    roots: () => roots,
    onChange: () => undefined,
    ...timeouts,
  });
  const lastRequestId = (): string => (sent[sent.length - 1] as { requestId: string }).requestId;
  /** Connects and answers the model list with one model. */
  const ready = (items = [MODEL]): void => {
    c.setOnline(true);
    c.handleFrame({ type: "models", requestId: "m0", items });
  };
  /** Sends a prompt and acks it with `conversationId`. */
  const open = (conversationId: string): void => {
    c.sendPrompt("x");
    c.handleFrame({ type: "prompt_ack", requestId: lastRequestId(), ok: true, conversationId });
  };
  return { c, sent, lastRequestId, open, ready };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("chat controller", () => {
  it("requests models and conversations when it comes online", () => {
    const { c, sent } = setup();
    c.setOnline(true);
    expect(sent.map((f) => f.type)).toEqual(["models_request", "conversations_request"]);
    expect(sent[1]).toMatchObject({ cwd: "/work/app" });
    expect(c.snapshot().modelsState).toBe("loading");
  });

  it("sends a prompt, adopts the conversation from the ack, and follows the transcript", () => {
    const { c, sent, lastRequestId, ready } = setup();
    ready();
    sent.length = 0;
    expect(c.sendPrompt("  hello ")).toBe(true);
    expect(sent[0]).toMatchObject({
      type: "prompt",
      cwd: "/work/app",
      text: "hello",
      approvalMode: "manual",
      model: "p::a",
    });
    expect(c.snapshot().busy).toBe(true);
    expect(c.snapshot().sending).toBe(true);
    expect(c.snapshot().running).toBe(false);
    c.handleFrame({ type: "prompt_ack", requestId: lastRequestId(), ok: true, conversationId: "c1" });
    expect(c.snapshot().sending).toBe(false);
    expect(c.snapshot().running).toBe(true);
    c.handleFrame({
      type: "transcript",
      conversationId: "c1",
      items: [{ kind: "user", id: "u1", text: "hello" }, { kind: "assistant", id: "m1", text: "Hi", status: "streaming" }],
    });
    expect(c.snapshot().conversationId).toBe("c1");
    expect(c.snapshot().items).toHaveLength(2);
    expect(c.snapshot().busy).toBe(true);
    expect(c.snapshot().running).toBe(true);
    c.handleFrame({
      type: "transcript",
      conversationId: "c1",
      items: [{ kind: "assistant", id: "m1", text: "Hi there", status: "done" }],
    });
    expect(c.snapshot().busy).toBe(false);
    expect(c.snapshot().running).toBe(false);
    sent.length = 0;
    c.sendPrompt("more");
    expect(sent[0]).toMatchObject({ type: "prompt", conversationId: "c1" });
  });

  it("keeps running while a tool is pending and stops after the reply is done", () => {
    const { c, lastRequestId, ready } = setup();
    ready();
    c.sendPrompt("x");
    c.handleFrame({ type: "prompt_ack", requestId: lastRequestId(), ok: true, conversationId: "c2" });
    c.handleFrame({
      type: "transcript",
      conversationId: "c2",
      items: [
        { kind: "user", id: "u", text: "x" },
        { kind: "tool", id: "t1", tool: "read_file", summary: "a.ts", status: "running" },
      ],
    });
    expect(c.snapshot().running).toBe(true);
    c.handleFrame({
      type: "transcript",
      conversationId: "c2",
      items: [
        { kind: "tool", id: "t1", tool: "read_file", summary: "a.ts", status: "done", durationMs: 40 },
        { kind: "assistant", id: "m", text: "ok", status: "done" },
      ],
    });
    expect(c.snapshot().running).toBe(false);
  });

  it("shows a failed ack as an error and stops being busy", () => {
    const { c, lastRequestId, ready } = setup();
    ready();
    c.sendPrompt("x");
    c.handleFrame({ type: "prompt_ack", requestId: lastRequestId(), ok: false, error: "busy", message: "run active" });
    expect(c.snapshot().busy).toBe(false);
    expect(c.snapshot().error).toEqual({ code: "busy" });
  });

  it("maps an unknown ack error to a generic error with the server text", () => {
    const { c, lastRequestId, ready } = setup();
    ready();
    c.sendPrompt("x");
    c.handleFrame({ type: "prompt_ack", requestId: lastRequestId(), ok: false, error: "weird", message: "nope" });
    expect(c.snapshot().error).toEqual({ code: "generic", message: "nope" });
  });

  it("refuses to send while offline or empty", () => {
    const { c } = setup();
    expect(c.sendPrompt("x")).toBe(false);
    expect(c.snapshot().error?.code).toBe("not_ready");
    c.setOnline(true);
    expect(c.sendPrompt("   ")).toBe(false);
  });

  it("sorts conversations by recency and opens one with a reset transcript request", () => {
    const { c, sent, ready } = setup();
    ready();
    c.handleFrame({
      type: "conversations",
      requestId: "l1",
      items: [
        { id: "a", title: "old", updatedAt: 1, approvalMode: "manual", cwd: "/work/app" },
        { id: "b", title: "new", updatedAt: 2, approvalMode: "auto", cwd: "/work/app" },
      ],
    });
    expect(c.snapshot().conversations.map((x) => x.id)).toEqual(["b", "a"]);
    expect(c.snapshot().conversationsState).toBe("ready");
    sent.length = 0;
    c.openConversation("b");
    expect(sent[0]).toMatchObject({ type: "conversation_request", conversationId: "b" });
    expect(c.snapshot().approvalMode).toBe("auto");
    expect(c.snapshot().loadingConversation).toBe(true);
    c.handleFrame({ type: "transcript", conversationId: "b", reset: true, items: [{ kind: "user", id: "u", text: "q" }] });
    expect(c.snapshot().items).toHaveLength(1);
    expect(c.snapshot().loadingConversation).toBe(false);
    sent.length = 0;
    c.sendPrompt("continue");
    expect(sent[0]).toMatchObject({ type: "prompt", conversationId: "b" });
  });

  it("starts a new conversation without the old id", () => {
    const { c, sent, open, ready } = setup();
    ready();
    open("c1");
    c.newConversation();
    expect(c.snapshot().conversationId).toBeNull();
    sent.length = 0;
    c.sendPrompt("fresh");
    expect(sent[0]).not.toHaveProperty("conversationId");
  });

  it("keeps the model if it is known, and drops it when the list no longer has it", () => {
    const { c } = setup();
    c.handleFrame({ type: "models", requestId: "m", items: [{ ref: "p::a", label: "A", provider: "P" }] });
    c.setModel("p::a");
    expect(c.snapshot().model).toBe("p::a");
    c.setModel("p::unknown");
    expect(c.snapshot().model).toBe("p::a");
    c.handleFrame({ type: "models", requestId: "m", items: [] });
    expect(c.snapshot().model).toBeNull();
  });

  it("uses the default model, then the first model, when none is selected", () => {
    const { c, sent } = setup();
    c.handleFrame({
      type: "models",
      requestId: "m",
      items: [MODEL, { ref: "p::b", label: "B", provider: "P" }],
      defaultRef: "p::b",
    });
    expect(c.snapshot().effectiveModel).toBe("p::b");
    c.setOnline(true);
    sent.length = 0;
    c.sendPrompt("x");
    expect(sent[0]).toMatchObject({ model: "p::b" });
    c.handleFrame({ type: "models", requestId: "m", items: [MODEL] });
    expect(c.snapshot().effectiveModel).toBe("p::a");
  });

  it("says no models when the server has none, and does not send", () => {
    const { c, sent, ready } = setup();
    ready([]);
    sent.length = 0;
    expect(c.snapshot().effectiveModel).toBeNull();
    expect(c.sendPrompt("x")).toBe(false);
    expect(c.snapshot().error).toEqual({ code: "no_models" });
    expect(sent.some((f) => f.type === "prompt")).toBe(false);
  });

  it("asks the user to choose a model while the list is still unknown", () => {
    const { c, sent } = setup();
    c.setOnline(true);
    sent.length = 0;
    expect(c.sendPrompt("x")).toBe(false);
    expect(c.snapshot().error).toEqual({ code: "no_model" });
    expect(sent).toHaveLength(0);
  });

  it("changes the approval mode locally before a conversation and on the wire after", () => {
    const { c, sent, open, ready } = setup();
    ready();
    sent.length = 0;
    c.setApprovalMode("auto");
    expect(c.snapshot().approvalMode).toBe("auto");
    expect(sent).toHaveLength(0);
    open("c1");
    expect(sent[0]).toMatchObject({ type: "prompt", approvalMode: "auto" });
    sent.length = 0;
    c.setApprovalMode("manual");
    expect(sent[0]).toMatchObject({ type: "set_approval_mode", conversationId: "c1", mode: "manual" });
    c.handleFrame({ type: "approval_mode", conversationId: "c1", mode: "manual", ok: true });
    expect(c.snapshot().approvalMode).toBe("manual");
  });

  it("requires confirmation for full access and passes it on", () => {
    const { c, sent, ready } = setup();
    ready();
    c.setApprovalMode("full");
    expect(c.snapshot().approvalMode).toBe("manual");
    expect(c.snapshot().error?.code).toBe("confirm_required");
    c.setApprovalMode("full", true);
    expect(c.snapshot().approvalMode).toBe("full");
    sent.length = 0;
    c.sendPrompt("x");
    expect(sent[0]).toMatchObject({ approvalMode: "full", confirmFull: true });
  });

  it("reports a server refusal of the mode change", () => {
    const { c, open, ready } = setup();
    ready();
    open("c1");
    c.setApprovalMode("full", true);
    c.handleFrame({ type: "approval_mode", conversationId: "c1", ok: false, error: "confirm_required" });
    expect(c.snapshot().error?.code).toBe("confirm_required");
  });

  it("stops the open conversation only", () => {
    const { c, sent, open, ready } = setup();
    ready();
    c.stop();
    expect(sent.some((f) => f.type === "stop")).toBe(false);
    open("c9");
    c.stop();
    expect(sent.filter((f) => f.type === "stop")).toEqual([
      expect.objectContaining({ type: "stop", conversationId: "c9" }),
    ]);
  });

  it("clears a pending ack when the connection drops, and re-reads on reconnect", () => {
    const { c, sent, ready } = setup();
    ready();
    c.sendPrompt("x");
    c.setOnline(false);
    expect(c.snapshot().busy).toBe(false);
    expect(c.snapshot().sending).toBe(false);
    sent.length = 0;
    c.setOnline(true);
    expect(sent.map((f) => f.type)).toContain("models_request");
  });

  it("only handles chat frames and switches folder", () => {
    const { c, sent } = setup(["/a", "/b"]);
    expect(c.handleFrame({ type: "cancel", runId: "r" })).toBe(false);
    c.setOnline(true);
    sent.length = 0;
    c.setCwd("/b");
    expect(c.snapshot().cwd).toBe("/b");
    expect(sent[sent.length - 1]).toMatchObject({ type: "conversations_request", cwd: "/b" });
    c.setCwd("/nope");
    expect(c.snapshot().cwd).toBe("/b");
  });

  describe("unsupported server", () => {
    it("sends no chat request frames and fails the prompt as unsupported", () => {
      const { c, sent } = setup();
      c.setServerInfo({ serverVersion: "0.5.4-beta.1" });
      expect(c.snapshot().chatSupport).toBe("unsupported");
      c.setOnline(true);
      expect(sent).toHaveLength(0);
      expect(c.sendPrompt("x")).toBe(false);
      expect(c.snapshot().error).toEqual({ code: "unsupported" });
      expect(sent).toHaveLength(0);
    });

    it("does not send the conversation request when it opens one", () => {
      const { c, sent } = setup();
      c.setServerInfo({ serverVersion: "0.5.4-beta.1" });
      c.openConversation("c1");
      expect(sent).toHaveLength(0);
      expect(c.snapshot().error).toEqual({ code: "unsupported" });
    });

    it("supports chat when the welcome lists the chat feature", () => {
      const { c, sent } = setup();
      c.setServerInfo({ serverVersion: "0.5.4-beta.2", features: ["chat"] });
      c.setOnline(true);
      expect(sent.map((f) => f.type)).toEqual(["models_request", "conversations_request"]);
      expect(c.snapshot().serverVersion).toBe("0.5.4-beta.2");
    });
  });

  describe("timeouts", () => {
    it("resets the models list when the server does not answer", () => {
      vi.useFakeTimers();
      const { c } = setup();
      c.setOnline(true);
      vi.advanceTimersByTime(9_999);
      expect(c.snapshot().modelsState).toBe("loading");
      vi.advanceTimersByTime(1);
      expect(c.snapshot().modelsState).toBe("error");
      expect(c.snapshot().error).toEqual({ code: "timeout" });
    });

    it("resets the conversation list when the server does not answer", () => {
      vi.useFakeTimers();
      const { c } = setup();
      c.setOnline(true);
      vi.advanceTimersByTime(10_000);
      expect(c.snapshot().conversationsState).toBe("error");
      expect(c.snapshot().error).toEqual({ code: "timeout" });
    });

    it("stops sending after the prompt ack times out", () => {
      vi.useFakeTimers();
      const { c, ready } = setup();
      ready();
      c.sendPrompt("x");
      vi.advanceTimersByTime(14_999);
      expect(c.snapshot().sending).toBe(true);
      vi.advanceTimersByTime(1);
      expect(c.snapshot().sending).toBe(false);
      expect(c.snapshot().busy).toBe(false);
      expect(c.snapshot().running).toBe(false);
      expect(c.snapshot().error).toEqual({ code: "timeout" });
    });

    it("applies a late answer after a timeout without harm", () => {
      vi.useFakeTimers();
      const { c, ready } = setup();
      ready();
      c.setOnline(true);
      vi.advanceTimersByTime(10_000);
      c.handleFrame({ type: "models", requestId: "m-late", items: [MODEL] });
      expect(c.snapshot().modelsState).toBe("ready");
      expect(c.snapshot().models).toHaveLength(1);
    });

    it("ends the loading state when a conversation does not load", () => {
      vi.useFakeTimers();
      const { c, ready } = setup();
      ready();
      c.openConversation("c5");
      expect(c.snapshot().loadingConversation).toBe(true);
      vi.advanceTimersByTime(10_000);
      expect(c.snapshot().loadingConversation).toBe(false);
      expect(c.snapshot().error).toEqual({ code: "timeout" });
    });

    it("treats an ack followed by no transcript as a run that never started", () => {
      vi.useFakeTimers();
      const { c, lastRequestId, ready } = setup();
      ready();
      c.sendPrompt("x");
      c.handleFrame({ type: "prompt_ack", requestId: lastRequestId(), ok: true, conversationId: "c7" });
      expect(c.snapshot().running).toBe(true);
      vi.advanceTimersByTime(29_999);
      expect(c.snapshot().running).toBe(true);
      vi.advanceTimersByTime(1);
      expect(c.snapshot().running).toBe(false);
      expect(c.snapshot().error).toEqual({ code: "timeout" });
    });

    it("stops the timers when disposed", () => {
      vi.useFakeTimers();
      const { c, ready } = setup();
      ready();
      c.sendPrompt("x");
      c.dispose();
      vi.advanceTimersByTime(60_000);
      expect(c.snapshot().error).toBeNull();
    });

    it("uses the configured timeouts", () => {
      vi.useFakeTimers();
      const { c } = setup(["/work/app"], { timeoutMs: 500 });
      c.setOnline(true);
      vi.advanceTimersByTime(500);
      expect(c.snapshot().modelsState).toBe("error");
    });
  });

  describe("error frames", () => {
    it("maps an error frame with a pending request id and resets the prompt", () => {
      const { c, lastRequestId, ready } = setup();
      ready();
      c.sendPrompt("x");
      const requestId = lastRequestId();
      expect(c.handleFrame({ type: "error", code: "quota", message: "limit", requestId })).toBe(true);
      expect(c.snapshot().sending).toBe(false);
      expect(c.snapshot().error).toEqual({ code: "quota" });
    });

    it("keeps the server text for an unknown code", () => {
      const { c, lastRequestId, ready } = setup();
      ready();
      c.sendPrompt("x");
      c.handleFrame({ type: "error", code: "mystery", message: "hmm", requestId: lastRequestId() });
      expect(c.snapshot().error).toEqual({ code: "generic", message: "hmm" });
    });

    it("marks the model list as failed on a model error", () => {
      const { c, sent } = setup();
      c.setOnline(true);
      const requestId = (sent[0] as { requestId: string }).requestId;
      c.handleFrame({ type: "error", code: "generic", message: "down", requestId });
      expect(c.snapshot().modelsState).toBe("error");
      expect(c.snapshot().error).toEqual({ code: "generic", message: "down" });
    });

    it("ignores an error frame with an unknown request id", () => {
      const { c } = setup();
      expect(c.handleFrame({ type: "error", code: "quota", requestId: "zzz" })).toBe(false);
      expect(c.snapshot().error).toBeNull();
    });

    it("ignores an error frame without a request id", () => {
      const { c } = setup();
      expect(c.handleFrame({ type: "error", code: "quota" })).toBe(false);
      expect(c.snapshot().error).toBeNull();
    });
  });

  it("refresh re-reads the lists and the open conversation", () => {
    const { c, sent, open, ready } = setup();
    ready();
    open("c3");
    sent.length = 0;
    c.refresh();
    expect(sent.map((f) => f.type)).toEqual(["models_request", "conversations_request", "conversation_request"]);
  });
});
