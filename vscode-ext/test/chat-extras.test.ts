import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatController, type ChatController } from "../src/chat/controller";
import type { PromptAttachment } from "../src/protocol/chat-frames";
import type { Frame } from "../src/protocol/frames";

const MODEL = { ref: "p::a", label: "A", provider: "P" };
const FILE: PromptAttachment = { name: "notes.txt", mime: "text/plain", data: "aGk=" };

function setup(timeoutMs?: number) {
  const sent: Frame[] = [];
  const c: ChatController = createChatController({
    send: (f) => {
      sent.push(f);
      return true;
    },
    roots: () => ["/work/app"],
    onChange: () => undefined,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  const lastRequestId = (): string => (sent[sent.length - 1] as { requestId: string }).requestId;
  const ready = (): void => {
    c.setOnline(true);
    c.handleFrame({ type: "models", requestId: "m0", items: [MODEL] });
  };
  const ack = (conversationId: string): void => {
    c.handleFrame({ type: "prompt_ack", requestId: lastRequestId(), ok: true, conversationId });
  };
  const finish = (conversationId: string): void => {
    c.handleFrame({
      type: "transcript",
      conversationId,
      items: [
        { kind: "user", id: "u0", text: "q" },
        { kind: "assistant", id: "a0", text: "ok", status: "done" },
      ],
    });
  };
  const prompts = (): Array<Extract<Frame, { type: "prompt" }>> =>
    sent.filter((f): f is Extract<Frame, { type: "prompt" }> => f.type === "prompt");
  const ofType = <T extends Frame["type"]>(type: T): Array<Extract<Frame, { type: T }>> =>
    sent.filter((f): f is Extract<Frame, { type: T }> => f.type === type);
  return { c, sent, lastRequestId, ready, ack, finish, prompts, ofType };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("prompt attachments", () => {
  it("sends the files in the prompt frame", () => {
    const t = setup();
    t.ready();
    t.sent.length = 0;
    expect(t.c.sendPrompt("look", { attachments: [FILE] })).toBe(true);
    expect(t.prompts()[0]).toMatchObject({ text: "look", attachments: [FILE] });
  });

  it("leaves the attachments key out when there are none", () => {
    const t = setup();
    t.ready();
    t.sent.length = 0;
    t.c.sendPrompt("plain", { attachments: [] });
    expect(t.prompts()[0]).not.toHaveProperty("attachments");
  });

  it("keeps the files of a prompt queued behind an active run", () => {
    const t = setup();
    t.ready();
    t.c.sendPrompt("first");
    t.ack("c1");
    t.c.sendPrompt("second", { attachments: [FILE] });
    expect(t.prompts()).toHaveLength(1);

    t.finish("c1");
    expect(t.prompts()).toHaveLength(2);
    expect(t.prompts()[1]).toMatchObject({ text: "second", conversationId: "c1", attachments: [FILE] });
  });

  it("sends the files with an interrupt", () => {
    const t = setup();
    t.ready();
    t.c.sendPrompt("first");
    t.ack("c1");
    t.c.sendPrompt("now", { interrupt: true, attachments: [FILE] });
    expect(t.prompts()[1]).toMatchObject({ text: "now", interrupt: true, attachments: [FILE] });
  });
});

describe("devices", () => {
  it("starts idle, asks on request, and shows the answer", () => {
    const t = setup();
    t.ready();
    expect(t.c.snapshot().devices).toEqual({ state: "idle", items: [] });
    t.c.requestDevices();
    expect(t.c.snapshot().devices.state).toBe("loading");
    const requestId = t.lastRequestId();
    expect(t.sent[t.sent.length - 1]).toMatchObject({ type: "devices_request" });

    const item = { name: "work-pc", kind: "vscode" as const, online: true, self: true, workspaces: ["/work/app"] };
    t.c.handleFrame({ type: "devices", requestId, items: [item] });
    expect(t.c.snapshot().devices).toEqual({ state: "ready", items: [item] });
  });

  it("ignores an answer that arrives after a newer request", () => {
    const t = setup();
    t.ready();
    t.c.requestDevices();
    const first = t.lastRequestId();
    t.c.requestDevices();
    t.c.handleFrame({ type: "devices", requestId: first, items: [] });
    expect(t.c.snapshot().devices.state).toBe("loading");
  });

  it("shows an error when the answer times out", () => {
    vi.useFakeTimers();
    const t = setup(1000);
    t.ready();
    t.c.requestDevices();
    vi.advanceTimersByTime(1000);
    expect(t.c.snapshot().devices).toEqual({ state: "error", items: [] });
  });

  it("is an error when offline, and nothing is sent", () => {
    const t = setup();
    t.c.requestDevices();
    expect(t.ofType("devices_request")).toHaveLength(0);
    expect(t.c.snapshot().devices.state).toBe("error");
  });
});

describe("compact", () => {
  it("sends compact_request for the open conversation and reports the counts", () => {
    const t = setup();
    t.ready();
    t.c.openConversation("c1");
    t.c.handleFrame({ type: "transcript", conversationId: "c1", reset: true, items: [] });
    const results: unknown[] = [];
    t.c.compact((r) => results.push(r));
    const request = t.ofType("compact_request");
    expect(request).toEqual([{ type: "compact_request", requestId: expect.any(String), conversationId: "c1" }]);

    t.c.handleFrame({ type: "compacted", requestId: request[0].requestId, conversationId: "c1", ok: true, before: 9000, after: 1200 });
    expect(results).toEqual([{ ok: true, before: 9000, after: 1200 }]);
    expect(t.ofType("context_request")).toHaveLength(2); // opening the conversation, then the compaction
  });

  it("reports a server error as a failure, without setting the chat error", () => {
    const t = setup();
    t.ready();
    t.c.openConversation("c1");
    const results: unknown[] = [];
    t.c.compact((r) => results.push(r));
    const requestId = t.ofType("compact_request")[0].requestId;
    t.c.handleFrame({ type: "error", code: "busy", requestId });
    expect(results).toEqual([{ ok: false }]);
    expect(t.c.snapshot().error).toBeNull();
  });

  it("reports a failure at once when no conversation is open", () => {
    const t = setup();
    t.ready();
    const results: unknown[] = [];
    t.c.compact((r) => results.push(r));
    expect(results).toEqual([{ ok: false }]);
    expect(t.ofType("compact_request")).toHaveLength(0);
  });

  it("reports a timeout as a failure", () => {
    vi.useFakeTimers();
    const t = setup(1000);
    t.ready();
    t.c.openConversation("c1");
    const results: unknown[] = [];
    t.c.compact((r) => results.push(r));
    vi.advanceTimersByTime(120_000);
    expect(results).toEqual([{ ok: false }]);
  });
});

describe("context refresh with a callback", () => {
  it("hands the answer to the caller", () => {
    const t = setup();
    t.ready();
    t.c.openConversation("c1");
    t.c.handleFrame({ type: "transcript", conversationId: "c1", reset: true, items: [] });
    const seen: unknown[] = [];
    t.c.refreshContext((u) => seen.push(u));
    const requestId = t.ofType("context_request").at(-1)?.requestId as string;
    t.c.handleFrame({ type: "context", requestId, total: 12_300, limit: 128_000, fits: true, estimated: false });
    expect(seen).toEqual([{ total: 12_300, limit: 128_000, fits: true, estimated: false }]);
  });
});
