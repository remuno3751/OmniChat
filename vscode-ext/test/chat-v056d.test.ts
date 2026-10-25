import { afterEach, describe, expect, it, vi } from "vitest";
import { decode } from "../src/protocol/codec";
import { createChatController, type ChatController } from "../src/chat/controller";
import { normalizeSettingsInput, MAX_SEARCH_QUERY } from "../src/chat/chatSettings";
import { conversationExport, conversationJson } from "../src/chat/exportJson";
import { effortLabel, parseEffortArg, parseSlash, runSlash, slashArg } from "../src/chat/slash";
import { parseChatMessage } from "../src/chat/viewModel";
import { createSettingsActions, isSettingsMessage } from "../src/chat/settingsActions";
import { stringsFor } from "../src/ui/strings";
import type { Frame } from "../src/protocol/frames";
import type { TranscriptItem } from "../src/protocol/chat-frames";

const en = stringsFor("en");

afterEach(() => vi.useRealTimers());

function setup(timeoutMs = 10_000) {
  const sent: Frame[] = [];
  const c: ChatController = createChatController({
    send: (f) => {
      sent.push(f);
      return true;
    },
    roots: () => ["/work/app"],
    onChange: () => undefined,
    timeoutMs,
  });
  const last = <T extends Frame["type"]>(type: T): Extract<Frame, { type: T }> => {
    const found = sent.filter((f) => f.type === type).at(-1);
    if (!found) throw new Error(`no ${type} sent`);
    return found as Extract<Frame, { type: T }>;
  };
  /** Online, one conversation open, its settings request answered. */
  const openWithSettings = (conversationId = "c1"): void => {
    c.setOnline(true);
    c.openConversation(conversationId);
    c.handleFrame({ type: "transcript", conversationId, reset: true, items: [] });
  };
  return { c, sent, last, openWithSettings };
}

const SETTINGS = { systemPrompt: "Be brief", systemMode: "append", effort: "off" } as const;

describe("protocol: v0.5.6-d frames", () => {
  it("decodes the settings and search answers", () => {
    const settings = { type: "conversation_settings", requestId: "g1", conversationId: "c1", title: "T", ...SETTINGS };
    expect(decode(JSON.stringify(settings))).toEqual(settings);
    const ack = { type: "conversation_settings_ack", requestId: "g2", conversationId: "c1", ok: true, settings: SETTINGS };
    expect(decode(JSON.stringify(ack))).toEqual(ack);
    const hits = {
      type: "history_search",
      requestId: "q1",
      query: "x",
      results: [{ conversationId: "c1", title: "T", messageId: "m1", role: "user", snippet: "a x b", at: 5 }],
    };
    expect(decode(JSON.stringify(hits))).toEqual(hits);
  });

  it("drops malformed answers: a bad effort, a bad mode, a bad hit", () => {
    const base = { type: "conversation_settings", requestId: "g1", conversationId: "c1", title: "T" };
    expect(decode(JSON.stringify({ ...base, ...SETTINGS, effort: "extreme" }))).toBeNull();
    expect(decode(JSON.stringify({ ...base, ...SETTINGS, systemMode: "prepend" }))).toBeNull();
    expect(decode(JSON.stringify({ type: "history_search", requestId: "q", query: "x", results: [{ conversationId: "c" }] }))).toBeNull();
    expect(decode(JSON.stringify({ type: "conversation_settings_ack", requestId: "g", conversationId: "c", ok: "yes" }))).toBeNull();
  });

  it("accepts off as an effort level", () => {
    const frame = { type: "conversation_settings", requestId: "g1", conversationId: "c1", title: "", ...SETTINGS, effort: "off" };
    expect(decode(JSON.stringify(frame))).not.toBeNull();
  });
});

describe("normalizeSettingsInput", () => {
  it("keeps only the given fields and trims the title", () => {
    expect(normalizeSettingsInput({ title: "  Plan  " })).toEqual({ title: "Plan" });
    expect(normalizeSettingsInput({ effort: null })).toEqual({ effort: null });
    expect(normalizeSettingsInput({ effort: "off", systemPrompt: "" })).toEqual({ effort: "off", systemPrompt: "" });
  });

  it("refuses out-of-range values", () => {
    expect(normalizeSettingsInput({ title: "   " })).toBeNull();
    expect(normalizeSettingsInput({ title: "x".repeat(201) })).toBeNull();
    expect(normalizeSettingsInput({ systemPrompt: "x".repeat(20001) })).toBeNull();
    expect(normalizeSettingsInput({ effort: "huge" as never })).toBeNull();
    expect(normalizeSettingsInput({ systemMode: "prepend" as never })).toBeNull();
  });
});

describe("effort and rename slash commands", () => {
  it("parses effort levels, default and off, and refuses the rest", () => {
    expect(parseEffortArg("off")).toEqual({ ok: true, effort: "off" });
    expect(parseEffortArg(" High ")).toEqual({ ok: true, effort: "high" });
    expect(parseEffortArg("default")).toEqual({ ok: true, effort: null });
    expect(parseEffortArg("")).toEqual({ ok: false });
    expect(parseEffortArg(undefined)).toEqual({ ok: false });
    expect(parseEffortArg("extreme")).toEqual({ ok: false });
  });

  it("labels every level", () => {
    expect(effortLabel("off", en)).toBe(en.csEffortOff);
    expect(effortLabel(null, en)).toBe(en.csEffortDefault);
    expect(effortLabel("max", en)).toBe(en.csEffortMax);
  });

  it("accepts effort and rename as slash names and reads the argument", () => {
    expect(parseSlash({ type: "slash", name: "effort" })).toBe("effort");
    expect(parseSlash({ type: "slash", name: "rename" })).toBe("rename");
    expect(slashArg({ type: "slash", name: "export", arg: "json" })).toBe("json");
    expect(slashArg({ type: "slash", name: "export", arg: "x".repeat(2001) })).toBeUndefined();
    expect(slashArg({ type: "slash", name: "export" })).toBeUndefined();
  });

  function deps(snapOver: Record<string, unknown> = {}) {
    const saveSettings = vi.fn((_input: unknown, onResult?: (ok: boolean) => void) => onResult?.(true));
    const controller = { snapshot: () => ({ conversationId: "c1", items: [], conversations: [{ id: "c1", title: "Old" }], ...snapOver }), saveSettings, newConversation: vi.fn(), refreshContext: vi.fn(), compact: vi.fn(), sendPrompt: vi.fn(), cancelQueued: vi.fn() };
    const d = {
      strings: en,
      controller: controller as never,
      toast: vi.fn(),
      globalState: { get: <T,>(_k: string, v: T) => v, update: vi.fn(async () => undefined) },
      onPinsChanged: vi.fn(),
      openDocument: vi.fn(),
    };
    return { d, saveSettings };
  }

  it("/effort saves the level and toasts it; a bad or missing argument toasts effortBad", () => {
    const ok = deps();
    runSlash("effort", ok.d, "off");
    expect(ok.saveSettings).toHaveBeenCalledWith({ effort: "off" }, expect.any(Function));
    expect(ok.d.toast).toHaveBeenCalledWith(en.effortSet.replace("{level}", en.csEffortOff));

    const bad = deps();
    runSlash("effort", bad.d, "warp");
    runSlash("effort", bad.d);
    expect(bad.saveSettings).not.toHaveBeenCalled();
    expect(bad.d.toast).toHaveBeenNthCalledWith(1, en.effortBad);
    expect(bad.d.toast).toHaveBeenNthCalledWith(2, en.effortBad);
  });

  it("/rename saves the title; no title toasts renameNeedTitle", () => {
    const r = deps();
    runSlash("rename", r.d, "  New name ");
    expect(r.saveSettings).toHaveBeenCalledWith({ title: "New name" }, expect.any(Function));
    expect(r.d.toast).toHaveBeenCalledWith(en.renameDone);

    const none = deps();
    runSlash("rename", none.d, "  ");
    expect(none.saveSettings).not.toHaveBeenCalled();
    expect(none.d.toast).toHaveBeenCalledWith(en.renameNeedTitle);
  });

  it("/export json opens JSON; plain /export still opens Markdown", () => {
    const j = deps({ items: [{ kind: "user", id: "u1", text: "hi" }] });
    runSlash("export", j.d, "json");
    expect(j.d.openDocument).toHaveBeenCalledWith(expect.stringContaining('"text": "hi"'), "json");
    const md = deps({ items: [{ kind: "user", id: "u1", text: "hi" }] });
    runSlash("export", md.d);
    expect(md.d.openDocument).toHaveBeenCalledWith(expect.stringContaining("## User"));
  });
});

describe("conversationExport", () => {
  const items: TranscriptItem[] = [
    { kind: "user", id: "u1", text: "Hello" },
    { kind: "assistant", id: "a1", text: "Hi", reasoning: "secret thoughts", status: "done" },
    { kind: "tool", id: "t1", tool: "read_file", summary: "src/a.ts", status: "done", durationMs: 12, decidedBy: "user" },
    { kind: "status", text: "Connection lost" },
  ];

  it("keeps messages and tool rows, drops status rows, reasoning, diffs and timings", () => {
    const out = conversationExport("  Talk ", "c1", items, Date.UTC(2026, 0, 2));
    expect(out).toEqual({
      title: "Talk",
      conversationId: "c1",
      exportedAt: "2026-01-02T00:00:00.000Z",
      items: [
        { kind: "user", id: "u1", text: "Hello" },
        { kind: "assistant", id: "a1", text: "Hi", status: "done" },
        { kind: "tool", id: "t1", tool: "read_file", summary: "src/a.ts", status: "done" },
      ],
    });
    expect(conversationJson("Talk", "c1", items, 0)).not.toContain("secret thoughts");
  });

  it("keeps a timestamp only when the item has one", () => {
    const stamped = [{ kind: "user", id: "u1", text: "x", at: 1700 }] as unknown as TranscriptItem[];
    expect(conversationExport("T", "c", stamped, 0).items[0]).toMatchObject({ at: 1700 });
    expect(conversationExport("T", "c", items, 0).items[0]).not.toHaveProperty("at");
  });

  it("writes JSON with a trailing newline", () => {
    const text = conversationJson("T", "c1", [], 0);
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ title: "T", items: [] });
  });
});

describe("webview messages", () => {
  it("parses the v0.5.6-d messages", () => {
    expect(parseChatMessage({ type: "requestSettings" })).toEqual({ type: "requestSettings" });
    expect(parseChatMessage({ type: "saveSettings", systemPrompt: "", systemMode: "replace", effort: null })).toEqual({
      type: "saveSettings",
      systemPrompt: "",
      systemMode: "replace",
      effort: null,
    });
    expect(parseChatMessage({ type: "setEffort", effort: "off" })).toEqual({ type: "setEffort", effort: "off" });
    expect(parseChatMessage({ type: "searchHistory", query: "abc" })).toEqual({ type: "searchHistory", query: "abc" });
    expect(parseChatMessage({ type: "openHit", conversationId: "c1", messageId: "m1" })).toEqual({
      type: "openHit",
      conversationId: "c1",
      messageId: "m1",
    });
    expect(parseChatMessage({ type: "openHit", conversationId: "c1" })).toEqual({ type: "openHit", conversationId: "c1" });
  });

  it("refuses invalid settings messages", () => {
    expect(parseChatMessage({ type: "saveSettings", systemPrompt: "x", systemMode: "prepend", effort: null })).toBeNull();
    expect(parseChatMessage({ type: "saveSettings", systemPrompt: "x", systemMode: "append", effort: "huge" })).toBeNull();
    expect(parseChatMessage({ type: "setEffort", effort: 3 })).toBeNull();
    expect(parseChatMessage({ type: "searchHistory", query: 5 })).toBeNull();
    expect(parseChatMessage({ type: "openHit", conversationId: "" })).toBeNull();
    expect(isSettingsMessage({ type: "openHit" })).toBe(true);
    expect(isSettingsMessage({ type: "send" })).toBe(false);
  });
});

describe("settings and search in the controller", () => {
  it("requests the settings of the open conversation and stores the answer", () => {
    const { c, last, openWithSettings } = setup();
    openWithSettings("c1");
    const req = last("conversation_settings_request");
    expect(req.conversationId).toBe("c1");
    expect(c.snapshot().settings.state).toBe("loading");
    c.handleFrame({ type: "conversation_settings", requestId: req.requestId, conversationId: "c1", title: "Plan", ...SETTINGS });
    expect(c.snapshot().settings).toEqual({ state: "ready", value: SETTINGS });
  });

  it("drops an answer for a conversation that is no longer open", () => {
    const { c, last, openWithSettings } = setup();
    openWithSettings("c1");
    const req = last("conversation_settings_request");
    c.openConversation("c2");
    c.handleFrame({ type: "conversation_settings", requestId: req.requestId, conversationId: "c1", title: "", ...SETTINGS });
    expect(c.snapshot().settings.value).toBeNull();
  });

  it("saves through the ack, renames the list entry and asks again", () => {
    const { c, last, sent, openWithSettings } = setup();
    openWithSettings("c1");
    const results: boolean[] = [];
    c.saveSettings({ title: "Renamed", effort: "off" }, (ok) => results.push(ok));
    const set = last("conversation_settings_set");
    expect(set).toMatchObject({ conversationId: "c1", title: "Renamed", effort: "off" });
    expect(set).not.toHaveProperty("systemPrompt");
    c.handleFrame({ type: "conversation_settings_ack", requestId: set.requestId, conversationId: "c1", ok: true, title: "Renamed", settings: SETTINGS });
    expect(results).toEqual([true]);
    expect(sent.at(-1)?.type).toBe("conversation_settings_request");
  });

  it("reports a refused save as false and sends nothing when the input is out of range", () => {
    const { c, sent, openWithSettings } = setup();
    openWithSettings("c1");
    const results: boolean[] = [];
    c.saveSettings({ title: "  " }, (ok) => results.push(ok));
    c.handleFrame({ type: "conversation_settings_ack", requestId: "nope", conversationId: "c1", ok: false, error: "invalid_frame" });
    expect(results).toEqual([false]);
    expect(sent.some((f) => f.type === "conversation_settings_set")).toBe(false);
  });

  it("reports a timed out save as false", () => {
    vi.useFakeTimers();
    const { c, openWithSettings } = setup(500);
    openWithSettings("c1");
    const results: boolean[] = [];
    c.saveSettings({ effort: "max" }, (ok) => results.push(ok));
    vi.advanceTimersByTime(600);
    expect(results).toEqual([false]);
  });

  it("a timed out settings request shows an error state", () => {
    vi.useFakeTimers();
    const { c, openWithSettings } = setup(500);
    openWithSettings("c1");
    vi.advanceTimersByTime(600);
    expect(c.snapshot().settings.state).toBe("error");
  });

  it("searches, keeps only the newest search, and clears on an empty query", () => {
    const { c, sent, last } = setup();
    c.setOnline(true);
    c.searchHistory("  first ");
    const first = last("history_search_request");
    expect(first).toMatchObject({ query: "first", limit: 30 });
    c.searchHistory("second");
    const second = last("history_search_request");
    c.handleFrame({ type: "history_search", requestId: first.requestId, query: "first", results: [] });
    expect(c.snapshot().search).toMatchObject({ query: "second", state: "loading" });
    const hit = { conversationId: "c9", title: "T", snippet: "a \u0001x\u0002 b", at: 1 };
    c.handleFrame({ type: "history_search", requestId: second.requestId, query: "second", results: [hit] });
    expect(c.snapshot().search).toEqual({ query: "second", state: "ready", hits: [hit] });
    c.searchHistory("   ");
    expect(c.snapshot().search).toEqual({ query: "", state: "idle", hits: [] });
    expect(sent.filter((f) => f.type === "history_search_request")).toHaveLength(2);
  });

  it("cuts a long search text to the limit", () => {
    const { c, last } = setup();
    c.setOnline(true);
    c.searchHistory("x".repeat(MAX_SEARCH_QUERY + 50));
    expect(last("history_search_request").query).toHaveLength(MAX_SEARCH_QUERY);
  });

  it("a server error on a search shows the search error state", () => {
    const { c, last } = setup();
    c.setOnline(true);
    c.searchHistory("abc");
    const req = last("history_search_request");
    c.handleFrame({ type: "error", code: "invalid_frame", requestId: req.requestId });
    expect(c.snapshot().search.state).toBe("error");
    expect(c.snapshot().error).toBeNull();
  });
});

describe("open hit", () => {
  it("scrolls to the message once its conversation has loaded", () => {
    const posted: unknown[] = [];
    const { c, openWithSettings } = setup();
    openWithSettings("c1");
    const actions = createSettingsActions({
      controller: c,
      strings: en,
      toast: () => undefined,
      post: (m) => posted.push(m),
    });
    actions.handle({ type: "openHit", conversationId: "c2", messageId: "m7" });
    actions.afterUpdate({ ...c.snapshot(), conversationId: "c2", loadingConversation: true, error: null });
    expect(posted).toEqual([]);
    actions.afterUpdate({ ...c.snapshot(), conversationId: "c2", loadingConversation: false, error: null });
    expect(posted).toEqual([{ type: "scrollToMessage", id: "m7" }]);
    actions.afterUpdate({ ...c.snapshot(), conversationId: "c2", loadingConversation: false, error: null });
    expect(posted).toHaveLength(1);
  });

  it("does nothing without a message id", () => {
    const posted: unknown[] = [];
    const { c, openWithSettings } = setup();
    openWithSettings("c1");
    const actions = createSettingsActions({ controller: c, strings: en, toast: () => undefined, post: (m) => posted.push(m) });
    actions.handle({ type: "openHit", conversationId: "c1" });
    actions.afterUpdate({ ...c.snapshot(), loadingConversation: false, error: null });
    expect(posted).toEqual([]);
  });
});
