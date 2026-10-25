import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatController, MAX_QUEUE, type ChatController } from "../src/chat/controller";
import type { Frame } from "../src/protocol/frames";

const MODEL = { ref: "p::a", label: "A", provider: "P" };

/** A controller with a fake clock (ms) that the test moves forward by hand. */
function setup() {
  const sent: Frame[] = [];
  let clock = 1_000_000;
  const c: ChatController = createChatController({
    send: (f) => {
      sent.push(f);
      return true;
    },
    roots: () => ["/work/app"],
    onChange: () => undefined,
    now: () => clock,
  });
  const lastRequestId = (): string => (sent[sent.length - 1] as { requestId: string }).requestId;
  const ready = (): void => {
    c.setOnline(true);
    c.handleFrame({ type: "models", requestId: "m0", items: [MODEL] });
  };
  /** Acks the last prompt on `conversationId`. */
  const ack = (conversationId: string): void => {
    c.handleFrame({ type: "prompt_ack", requestId: lastRequestId(), ok: true, conversationId });
  };
  /** Finishes the run on `conversationId` (its transcript shows a reply after the ack). */
  const finish = (conversationId: string, replies = 1): void => {
    const items = [];
    for (let i = 0; i < replies; i += 1) {
      items.push({ kind: "user" as const, id: `u${i}`, text: `q${i}` }, { kind: "assistant" as const, id: `a${i}`, text: "ok", status: "done" as const });
    }
    c.handleFrame({ type: "transcript", conversationId, items });
  };
  const prompts = (): Array<Extract<Frame, { type: "prompt" }>> =>
    sent.filter((f): f is Extract<Frame, { type: "prompt" }> => f.type === "prompt");
  return {
    c,
    sent,
    prompts,
    ready,
    ack,
    finish,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("send guard", () => {
  it("sends nothing while offline and reports why", () => {
    const { c, sent } = setup();
    expect(c.sendPrompt("hello")).toBe(false);
    expect(c.snapshot().error).toEqual({ code: "not_ready" });
    expect(sent).toHaveLength(0);
  });

  it("does not send a second prompt with the same text within 300 ms (double click)", () => {
    const t = setup();
    t.ready();
    expect(t.c.sendPrompt("hi")).toBe(true);
    t.ack("c1");
    t.finish("c1");
    expect(t.c.sendPrompt("hi")).toBe(false);
    expect(t.prompts()).toHaveLength(1);
    t.advance(301);
    expect(t.c.sendPrompt("hi")).toBe(true);
    expect(t.prompts()).toHaveLength(2);
  });
});

describe("queue", () => {
  it("queues a prompt written while a run is active and sends it when the run ends", () => {
    const t = setup();
    t.ready();
    t.c.sendPrompt("first");
    t.ack("c1");
    expect(t.c.sendPrompt("second")).toBe(true);
    expect(t.prompts()).toHaveLength(1);
    expect(t.c.snapshot().queue.map((q) => q.text)).toEqual(["second"]);

    t.finish("c1");
    expect(t.prompts()).toHaveLength(2);
    expect(t.prompts()[1]).toMatchObject({ text: "second", conversationId: "c1" });
    expect(t.c.snapshot().queue).toEqual([]);
  });

  it("caps the queue at 10 and reports busy after that", () => {
    const t = setup();
    t.ready();
    t.c.sendPrompt("running");
    t.ack("c1");
    for (let i = 0; i < MAX_QUEUE; i += 1) {
      t.advance(1000);
      expect(t.c.sendPrompt(`q${i}`)).toBe(true);
    }
    t.advance(1000);
    expect(t.c.sendPrompt("one too many")).toBe(false);
    expect(t.c.snapshot().error).toEqual({ code: "busy" });
    expect(t.c.snapshot().queue).toHaveLength(MAX_QUEUE);
  });

  it("removes a queued prompt by id", () => {
    const t = setup();
    t.ready();
    t.c.sendPrompt("running");
    t.ack("c1");
    t.c.sendPrompt("dropped");
    t.c.sendPrompt("kept");
    const [dropped] = t.c.snapshot().queue;
    t.c.cancelQueued(dropped.id);
    expect(t.c.snapshot().queue.map((q) => q.text)).toEqual(["kept"]);
    t.finish("c1");
    expect(t.prompts().map((p) => p.text)).toEqual(["running", "kept"]);
  });

  it("keeps queued prompts when the connection drops", () => {
    const t = setup();
    t.ready();
    t.c.sendPrompt("running");
    t.ack("c1");
    t.c.sendPrompt("later");
    t.c.setOnline(false); // the run is gone with the connection
    expect(t.c.snapshot().queue.map((q) => q.text)).toEqual(["later"]);
  });
});

describe("interrupt", () => {
  it("sends at once with interrupt:true while a run is active", () => {
    const t = setup();
    t.ready();
    t.c.sendPrompt("running");
    t.ack("c1");
    expect(t.c.sendPrompt("now", { interrupt: true })).toBe(true);
    expect(t.prompts()[1]).toMatchObject({ text: "now", interrupt: true, conversationId: "c1" });
    expect(t.c.snapshot().queue).toEqual([]);
  });

  it("puts an interrupting prompt at the front of the queue while a prompt is still awaiting its ack", () => {
    const t = setup();
    t.ready();
    t.c.sendPrompt("awaiting");
    t.c.sendPrompt("queued");
    t.c.sendPrompt("urgent", { interrupt: true });
    expect(t.c.snapshot().queue.map((q) => q.text)).toEqual(["urgent", "queued"]);
    expect(t.prompts()).toHaveLength(1);
  });
});

describe("search mode", () => {
  it("is sent with every prompt once set, and inherited (absent) when unset", () => {
    const t = setup();
    t.ready();
    t.c.sendPrompt("a");
    expect(t.prompts()[0]).not.toHaveProperty("searchMode");
    t.ack("c1");
    t.finish("c1");
    t.c.setSearchMode("always");
    t.c.sendPrompt("b");
    expect(t.prompts()[1]).toMatchObject({ searchMode: "always" });
    expect(t.c.snapshot().searchMode).toBe("always");
  });

  it("takes the mode of a conversation when it is opened", () => {
    const t = setup();
    t.ready();
    t.c.handleFrame({
      type: "conversations",
      requestId: t.sent.filter((f) => f.type === "conversations_request").map((f) => (f as { requestId: string }).requestId)[0],
      items: [{ id: "x", title: "t", updatedAt: 1, approvalMode: "manual", cwd: "/work/app", searchMode: "off" }],
    });
    t.c.openConversation("x");
    expect(t.c.snapshot().searchMode).toBe("off");
  });
});

describe("context meter", () => {
  it("asks for the usage when a conversation is loaded, and when a run ends", () => {
    const t = setup();
    t.ready();
    t.c.openConversation("c1");
    t.c.handleFrame({ type: "transcript", conversationId: "c1", reset: true, items: [] });
    const first = t.sent.filter((f) => f.type === "context_request");
    expect(first).toHaveLength(1);
    const requestId = (first[0] as { requestId: string }).requestId;
    t.c.handleFrame({ type: "context", requestId, total: 12_300, limit: 128_000, fits: true, estimated: true });
    expect(t.c.snapshot().context).toEqual({ total: 12_300, limit: 128_000, fits: true, estimated: true });

    t.c.sendPrompt("go");
    t.ack("c1");
    t.finish("c1");
    expect(t.sent.filter((f) => f.type === "context_request")).toHaveLength(2);
  });

  it("refreshes after the draft has been quiet for 800 ms, not before", () => {
    vi.useFakeTimers();
    const t = setup();
    t.ready();
    t.c.openConversation("c1");
    const before = t.sent.filter((f) => f.type === "context_request").length;
    t.c.draftChanged();
    vi.advanceTimersByTime(500);
    t.c.draftChanged();
    vi.advanceTimersByTime(799);
    expect(t.sent.filter((f) => f.type === "context_request").length).toBe(before);
    vi.advanceTimersByTime(1);
    expect(t.sent.filter((f) => f.type === "context_request").length).toBe(before + 1);
  });

  it("stays quiet when the usage request fails", () => {
    const t = setup();
    t.ready();
    t.c.openConversation("c1");
    t.c.handleFrame({ type: "transcript", conversationId: "c1", reset: true, items: [] });
    const requestId = (t.sent.find((f) => f.type === "context_request") as { requestId: string }).requestId;
    t.c.handleFrame({ type: "error", code: "not_found", requestId });
    expect(t.c.snapshot().error).toBeNull();
    expect(t.c.snapshot().context).toBeNull();
  });
});
