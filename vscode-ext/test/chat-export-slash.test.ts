import { describe, expect, it, vi } from "vitest";
import { conversationMarkdown } from "../src/chat/exportConv";
import { parseSlash, runSlash, usageToast } from "../src/chat/slash";
import { PINS_KEY } from "../src/chat/pins";
import type { MementoLike } from "../src/chat/favorites";
import { stringsFor } from "../src/ui/strings";
import type { TranscriptItem } from "../src/protocol/chat-frames";

const en = stringsFor("en");

describe("conversationMarkdown", () => {
  it("writes the user and assistant text, one line per tool call, and skips reasoning and status rows", () => {
    const items: TranscriptItem[] = [
      { kind: "user", id: "u1", text: "List the files" },
      { kind: "assistant", id: "a1", text: "", reasoning: "hmm", status: "done" },
      { kind: "tool", id: "t1", tool: "list_dir", summary: "src\n  (3 entries)", status: "done" },
      { kind: "assistant", id: "a2", text: "Here they are.", status: "done" },
      { kind: "status", text: "Connection lost" },
    ];
    const md = conversationMarkdown("Files  of\nproject", items);
    expect(md).toBe(
      "# Files of project\n\n## User\n\nList the files\n\n- Tool `list_dir`: src (3 entries)\n\n## Assistant\n\nHere they are.\n",
    );
    expect(md).not.toContain("hmm");
    expect(md).not.toContain("Connection lost");
  });

  it("falls back to a plain heading for an untitled conversation and an empty one", () => {
    expect(conversationMarkdown("  ", [])).toBe("# Conversation\n");
  });
});

describe("usageToast", () => {
  const base = { total: 12_300, limit: 128_000, fits: true, estimated: false };

  it("shows only the context line when there is no breakdown", () => {
    expect(usageToast(base, en)).toBe("Context: 12.3k / 128k (10%)");
  });

  it("adds the breakdown fields the server sent", () => {
    const usage = {
      ...base,
      used: { system: 1200, history: 9800, attachments: 0, tools: 2400, input: 150 },
      reasoning: 300,
    };
    expect(usageToast(usage, en)).toBe(
      "Context: 12.3k / 128k (10%) · System 1.2k, History 9.8k, Attachments 0, Tools 2.4k, Draft 150, Reasoning 300",
    );
  });
});

describe("parseSlash", () => {
  it("accepts the host commands from the composer and rejects the webview ones", () => {
    for (const name of ["clear", "context", "compact", "usage", "retry", "pin", "export"]) {
      expect(parseSlash({ type: "slash", name })).toBe(name);
    }
    expect(parseSlash({ type: "slash", name: "model" })).toBeNull();
    expect(parseSlash({ type: "slash", name: "bogus" })).toBeNull();
    expect(parseSlash({ type: "send", name: "pin" })).toBeNull();
  });
});

describe("runSlash for the v0.5.6 commands", () => {
  function deps(snap: Record<string, unknown>) {
    const controller = {
      snapshot: () => snap,
      newConversation: vi.fn(),
      refreshContext: vi.fn(),
      compact: vi.fn(),
      sendPrompt: vi.fn(() => true),
      cancelQueued: vi.fn(),
    };
    const store = new Map<string, unknown>();
    const globalState: MementoLike = {
      get: <T>(k: string, d: T) => (store.has(k) ? (store.get(k) as T) : d),
      update: vi.fn(async (k: string, v: unknown) => void store.set(k, v)),
    };
    return {
      controller,
      store,
      d: {
        strings: en,
        controller: controller as never,
        toast: vi.fn(),
        globalState,
        onPinsChanged: vi.fn(),
        openDocument: vi.fn(),
      },
    };
  }
  const open = { conversationId: "c1", items: [], context: null, conversations: [] };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("each new command needs an open conversation", () => {
    for (const name of ["usage", "retry", "pin", "export"] as const) {
      const { d, store } = deps({ ...open, conversationId: null });
      runSlash(name, d);
      expect(d.toast).toHaveBeenCalledWith(en.slashNeedConversation);
      expect(store.size).toBe(0);
    }
  });

  it("usage toasts the known usage, or that it is unknown", () => {
    const known = deps({ ...open, context: { total: 500, limit: 1000, fits: true, estimated: true } });
    runSlash("usage", known.d);
    expect(known.d.toast).toHaveBeenCalledWith("Context: 500 / 1k (50%)");
    const unknown = deps(open);
    runSlash("usage", unknown.d);
    expect(unknown.d.toast).toHaveBeenCalledWith(en.slashContextUnknown);
  });

  it("retry resends the prompt of the last assistant reply", () => {
    const items: TranscriptItem[] = [
      { kind: "user", id: "u1", text: "first" },
      { kind: "assistant", id: "a1", text: "one", status: "done" },
      { kind: "user", id: "u2", text: "second" },
      { kind: "assistant", id: "a2", text: "two", status: "done" },
    ];
    const { d, controller } = deps({ ...open, items });
    runSlash("retry", d);
    expect(controller.sendPrompt).toHaveBeenCalledWith("second");
    expect(d.toast).not.toHaveBeenCalled();
  });

  it("retry says so when there is nothing to retry or a run is active", () => {
    const none = deps({ ...open, items: [{ kind: "user", id: "u1", text: "hi" }] });
    runSlash("retry", none.d);
    expect(none.d.toast).toHaveBeenCalledWith(en.slashNeedConversation);

    const busy = deps({
      ...open,
      busy: true,
      items: [
        { kind: "user", id: "u1", text: "hi" },
        { kind: "assistant", id: "a1", text: "yo", status: "done" },
      ],
    });
    runSlash("retry", busy.d);
    expect(busy.controller.sendPrompt).not.toHaveBeenCalled();
    expect(busy.d.toast).toHaveBeenCalledWith(en.slashRetryNotNow);
  });

  it("pin toggles the open conversation, toasts, and asks for a history redraw", async () => {
    const { d, store } = deps(open);
    runSlash("pin", d);
    await flush();
    expect(store.get(PINS_KEY)).toEqual(["c1"]);
    expect(d.toast).toHaveBeenLastCalledWith(en.slashPinned);
    expect(d.onPinsChanged).toHaveBeenCalledOnce();
    runSlash("pin", d);
    await flush();
    expect(store.get(PINS_KEY)).toEqual([]);
    expect(d.toast).toHaveBeenLastCalledWith(en.slashUnpinned);
  });

  it("export hands the Markdown of the open conversation to the editor", () => {
    const items: TranscriptItem[] = [{ kind: "user", id: "u1", text: "hello" }];
    const { d } = deps({ ...open, items, conversations: [{ id: "c1", title: "Greeting" }] });
    runSlash("export", d);
    expect(d.openDocument).toHaveBeenCalledWith("# Greeting\n\n## User\n\nhello\n");
  });
});
