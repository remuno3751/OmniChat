import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, type ClientStatus, type RetryInfo } from "../src/conn/client";
import { createLinkTracker } from "../src/chat/link";
import { averageRtt, buildBanner, buildChatState, buildContextView, formatTokens, parseChatMessage } from "../src/chat/viewModel";
import { stringsFor } from "../src/ui/strings";
import { isComposingKey } from "../src/webview/chat/composer";
import { latencyBand } from "../src/webview/chat/header";
import type { ChatSnapshot } from "../src/chat/controller";

afterEach(() => {
  vi.useRealTimers();
});

/** A socket stand-in: records pings and lets the test emit pong/open/close. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  pings = 0;
  sent: string[] = [];
  ping(): void {
    this.pings += 1;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.emit("close", 1000);
  }
  terminate(): void {
    this.emit("close", 1006);
  }
}

const baseOpts = (overrides: Record<string, unknown> = {}) => ({
  url: "ws://127.0.0.1:1/",
  token: "t",
  name: "n",
  instance: "i",
  version: "0.5.5",
  tools: [] as never[],
  workspaces: () => [],
  onFrame: () => undefined,
  onStatus: () => undefined,
  random: () => 0.5, // jitter factor 1.0: the delay is exactly the backoff base
  ...overrides,
});

describe("client reconnect and latency", () => {
  it("schedules each retry with its attempt number and the time it fires at", () => {
    vi.useFakeTimers({ now: 10_000 });
    const statuses: Array<[ClientStatus, string | undefined, RetryInfo | undefined]> = [];
    const client = createClient(
      baseOpts({
        wsFactory: () => {
          throw new Error("no network");
        },
        onStatus: (s: ClientStatus, d?: string, r?: RetryInfo) => statuses.push([s, d, r]),
      }) as never,
    );
    const offline = statuses.filter(([s]) => s === "offline");
    expect(offline[0]).toEqual(["offline", "connect failed", { attempt: 1, nextRetryAt: 11_000 }]);

    vi.advanceTimersByTime(1000); // first retry fires, fails again: backoff doubles
    const second = statuses.filter(([s]) => s === "offline")[1];
    expect(second[2]).toEqual({ attempt: 2, nextRetryAt: 13_000 });
    client.close();
  });

  it("reports the round trip of a ping as onLatency", () => {
    vi.useFakeTimers({ now: 0 });
    const sock = new FakeSocket();
    const latencies: number[] = [];
    const client = createClient(
      baseOpts({
        wsFactory: () => sock as unknown as import("ws").default,
        onLatency: (ms: number) => latencies.push(ms),
      }) as never,
    );
    sock.emit("open");
    vi.advanceTimersByTime(5000); // ping interval is 5 s
    expect(sock.pings).toBe(1);
    vi.advanceTimersByTime(42);
    sock.emit("pong");
    expect(latencies).toEqual([42]);
    client.close();
  });
});

describe("buildBanner", () => {
  const strings = stringsFor("en");
  it("shows the reconnect countdown while the link is down", () => {
    const banner = buildBanner({
      online: false,
      connecting: false,
      reconnectSec: 4,
      chatSupport: "ok",
      modelsState: "idle",
      modelCount: 0,
      strings,
    });
    expect(banner).toEqual({ kind: "reconnecting", text: "Reconnecting… (retry in 4 s)" });
  });

  it("uses the Japanese wording", () => {
    const banner = buildBanner({
      online: false,
      connecting: false,
      reconnectSec: 9,
      chatSupport: "ok",
      modelsState: "idle",
      modelCount: 0,
      strings: stringsFor("ja"),
    });
    expect(banner?.text).toBe("再接続中… (9秒後に再試行)");
  });

  it("keeps the connecting and offline banners when no retry is scheduled", () => {
    const base = { online: false, chatSupport: "ok" as const, modelsState: "idle" as const, modelCount: 0, strings };
    expect(buildBanner({ ...base, connecting: true, reconnectSec: null })?.kind).toBe("connecting");
    expect(buildBanner({ ...base, connecting: false, reconnectSec: null })?.kind).toBe("offline");
  });
});

describe("chat state link and context", () => {
  const snapshot = (over: Partial<ChatSnapshot> = {}): ChatSnapshot => ({
    online: false,
    cwd: "/work/app",
    cwds: ["/work/app"],
    models: [],
    model: null,
    defaultModel: null,
    effectiveModel: null,
    approvalMode: "manual",
    conversations: [],
    conversationId: null,
    items: [],
    busy: false,
    sending: false,
    running: false,
    error: null,
    chatSupport: "ok",
    serverVersion: null,
    modelsState: "idle",
    conversationsState: "idle",
    loadingConversation: false,
    searchMode: null,
    queue: [],
    context: null,
    devices: { state: "idle", items: [] },
    settings: { state: "idle", value: null },
    search: { query: "", state: "idle", hits: [] },
    checkpoints: { conversationId: null, state: "idle", items: [], restoring: null, error: false },
    ...over,
  });

  it("turns the retry time into a countdown and carries the round trip", () => {
    const state = buildChatState({
      lang: "en",
      paired: true,
      status: "offline",
      snapshot: snapshot(),
      approvals: [],
      link: { rttMs: 30, reconnect: { attempt: 2, nextRetryAt: 12_500 } },
      now: 10_000,
    });
    expect(state.link).toEqual({ rttMs: 30, reconnect: { attempt: 2, retryInMs: 2500 } });
    expect(state.banner).toEqual({ kind: "reconnecting", text: "Reconnecting… (retry in 3 s)" });
  });

  it("hides the context meter when the limit is unknown", () => {
    expect(buildContextView({ total: 10, limit: 0, fits: true, estimated: false }, stringsFor("en"))).toEqual({ text: "10 tokens", pct: 0, level: "ok" });
    expect(buildContextView({ total: 0, limit: 0, fits: true, estimated: false }, stringsFor("en"))).toBeNull();
    expect(buildContextView(null, stringsFor("en"))).toBeNull();
  });

  it("formats usage with warn at 80 % and full when it does not fit", () => {
    const en = stringsFor("en");
    expect(buildContextView({ total: 12_300, limit: 128_000, fits: true, estimated: true }, en)).toEqual({
      text: "~12.3k / 128k (10%)",
      pct: 10,
      level: "ok",
    });
    expect(buildContextView({ total: 110_000, limit: 128_000, fits: true, estimated: false }, en)?.level).toBe("warn");
    expect(buildContextView({ total: 130_000, limit: 128_000, fits: false, estimated: false }, en)?.level).toBe("full");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });

  it("averages ping round trips and tracks reconnects in the link tracker", () => {
    const changes: number[] = [];
    const link = createLinkTracker(() => changes.push(1));
    link.onLatency(100);
    link.onLatency(200);
    expect(link.info().rttMs).toBe(150);
    expect(averageRtt([])).toBeNull();
    link.onStatus("offline", { attempt: 1, nextRetryAt: 5 });
    expect(link.info()).toEqual({ rttMs: null, reconnect: { attempt: 1, nextRetryAt: 5 } });
    link.onStatus("online");
    expect(link.info().reconnect).toBeNull();
    expect(changes).toHaveLength(2);
  });
});

describe("parseChatMessage additions", () => {
  it("accepts the new webview messages", () => {
    expect(parseChatMessage({ type: "sendInterrupt", text: "stop that" })).toEqual({ type: "sendInterrupt", text: "stop that" });
    expect(parseChatMessage({ type: "cancelQueued", id: "q3" })).toEqual({ type: "cancelQueued", id: "q3" });
    expect(parseChatMessage({ type: "setSearchMode", mode: "always" })).toEqual({ type: "setSearchMode", mode: "always" });
    expect(parseChatMessage({ type: "toggleSettings" })).toEqual({ type: "toggleSettings" });
    expect(parseChatMessage({ type: "draftChanged" })).toEqual({ type: "draftChanged" });
  });

  it("rejects bad search modes, empty interrupts and oversized queue ids", () => {
    expect(parseChatMessage({ type: "setSearchMode", mode: "maybe" })).toBeNull();
    expect(parseChatMessage({ type: "sendInterrupt", text: "   " })).toBeNull();
    expect(parseChatMessage({ type: "cancelQueued", id: "x".repeat(65) })).toBeNull();
  });

  it("validates openFile: a path up to 1000 characters and an integer line", () => {
    expect(parseChatMessage({ type: "openFile", path: "src/a.ts", line: 12 })).toEqual({ type: "openFile", path: "src/a.ts", line: 12 });
    expect(parseChatMessage({ type: "openFile", path: "src/a.ts" })).toEqual({ type: "openFile", path: "src/a.ts" });
    expect(parseChatMessage({ type: "openFile", path: "a".repeat(1001) })).toBeNull();
    expect(parseChatMessage({ type: "openFile", path: "" })).toBeNull();
    expect(parseChatMessage({ type: "openFile", path: "a.ts", line: 1.5 })).toBeNull();
    expect(parseChatMessage({ type: "openFile", path: "a.ts", line: "3" })).toBeNull();
    expect(parseChatMessage({ type: "openFile", path: "a.ts", line: 0 })).toBeNull();
    expect(parseChatMessage({ type: "openFile", path: "a\u0000.ts" })).toBeNull();
  });
});

describe("header and composer helpers", () => {
  it("bands latency like the app: under 150 good, up to 500 slow, above bad", () => {
    expect(latencyBand(true, 149)).toBe("good");
    expect(latencyBand(true, 150)).toBe("slow");
    expect(latencyBand(true, 500)).toBe("slow");
    expect(latencyBand(true, 501)).toBe("bad");
    expect(latencyBand(true, null)).toBe("good");
    expect(latencyBand(false, 20)).toBe("off");
  });

  it("does not treat a Process key or a 229 keycode alone as an IME composition", () => {
    expect(isComposingKey({ isComposing: false, keyCode: 13, key: "Enter" })).toBe(false);
    expect(isComposingKey({ isComposing: true, keyCode: 13, key: "Enter" })).toBe(true);
    expect(isComposingKey({ isComposing: false, keyCode: 229, key: "Enter" })).toBe(false);
    expect(isComposingKey({ isComposing: false, keyCode: 229, key: "Process" })).toBe(true);
  });
});
