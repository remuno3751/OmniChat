import { describe, expect, it } from "vitest";
import { createChatController } from "../src/chat/controller";
import { buildBanner, buildChatState, parseChatMessage } from "../src/chat/viewModel";
import { buildSettingsState, parseSettingsMessage, validateSetting } from "../src/ui/settingsModel";
import { pickLang, stringsFor } from "../src/ui/strings";

describe("i18n", () => {
  it("picks Japanese only for ja locales", () => {
    expect(pickLang("ja")).toBe("ja");
    expect(pickLang("ja-JP")).toBe("ja");
    expect(pickLang("en")).toBe("en");
    expect(pickLang("de")).toBe("en");
    expect(pickLang(undefined)).toBe("en");
  });

  it("has the same keys in both languages", () => {
    const keys = (o: object): string[] =>
      Object.entries(o).flatMap(([k, v]) => (typeof v === "object" ? keys(v as object).map((x) => `${k}.${x}`) : [k]));
    expect(keys(stringsFor("ja")).sort()).toEqual(keys(stringsFor("en")).sort());
  });
});

describe("chat view state", () => {
  it("renders tool labels, localised errors and approval cards", () => {
    const c = createChatController({ send: () => true, roots: () => ["/w"], onChange: () => undefined });
    c.handleFrame({
      type: "transcript",
      conversationId: "c1",
      items: [{ kind: "tool", id: "k1", tool: "edit_file", summary: "src/a.ts", status: "running" }],
    });
    c.sendPrompt("offline");
    const state = buildChatState({
      lang: "en",
      paired: true,
      status: "offline",
      snapshot: c.snapshot(),
      approvals: [
        { type: "approval", requestId: "r", approvalId: "a1", callId: "", tool: "edit_file", path: "src/a.ts", reason: "x", protected: false },
      ],
    });
    expect(state.errorText).toBe(stringsFor("en").errors.not_ready);
    expect(state.approvals[0]?.actions.map((a) => a.id)).toEqual(["rejected", "allowed-once"]);
    expect(state.toolLabels).toEqual({});
    const withItems = buildChatState({
      lang: "ja",
      paired: true,
      status: "online",
      snapshot: { ...c.snapshot(), items: [{ kind: "tool", id: "k1", tool: "edit_file", summary: "src/a.ts", status: "running" }] },
      approvals: [],
    });
    expect(withItems.toolLabels.k1).toBe("edit_file  src/a.ts");
    expect(withItems.strings.send).toBe("送信");
  });
});

describe("parseChatMessage", () => {
  it("accepts well-formed messages", () => {
    expect(parseChatMessage({ type: "send", text: "hi" })).toEqual({ type: "send", text: "hi" });
    expect(parseChatMessage({ type: "setModel", ref: null })).toEqual({ type: "setModel", ref: null });
    expect(parseChatMessage({ type: "setApprovalMode", mode: "auto" })).toEqual({ type: "setApprovalMode", mode: "auto" });
    expect(parseChatMessage({ type: "approval_reply", approvalId: "a", decision: "rejected" })).toEqual({
      type: "approval_reply",
      approvalId: "a",
      decision: "rejected",
    });
    expect(parseChatMessage({ type: "stop", extra: 1 })).toEqual({ type: "stop" });
  });

  it("rejects malformed ones", () => {
    for (const raw of [
      null,
      "x",
      {},
      { type: "send", text: "   " },
      { type: "send", text: 5 },
      { type: "send", text: "x".repeat(100_001) },
      { type: "setApprovalMode", mode: "yolo" },
      { type: "approval_reply", approvalId: "a", decision: "allowed-always" },
      { type: "openConversation" },
      { type: "pair", code: "" },
      { type: "nope" },
    ]) {
      expect(parseChatMessage(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});

describe("chat banner, history and errors", () => {
  const en = stringsFor("en");
  const base = { online: true, connecting: false, chatSupport: "ok" as const, modelsState: "ready" as const, modelCount: 1, strings: en };

  it("picks the banner by priority", () => {
    expect(buildBanner({ ...base, chatSupport: "unsupported", modelCount: 0 })).toEqual({
      kind: "unsupported",
      text: en.unsupportedServer,
    });
    expect(buildBanner({ ...base, online: false, connecting: true })).toEqual({ kind: "connecting", text: en.connecting });
    expect(buildBanner({ ...base, online: false })).toEqual({ kind: "offline", text: en.offline });
    // offline wins over unsupported: the connection problem is what the user can act on
    expect(buildBanner({ ...base, online: false, chatSupport: "unsupported" })?.kind).toBe("offline");
    expect(buildBanner({ ...base, modelCount: 0 })).toEqual({ kind: "no_models", text: en.noModels });
    expect(buildBanner({ ...base, modelsState: "loading", modelCount: 0 })).toBeNull();
    expect(buildBanner(base)).toBeNull();
  });

  it("disables chat offline or on an unsupported server", () => {
    const c = createChatController({ send: () => true, roots: () => ["/w"], onChange: () => undefined });
    const off = buildChatState({ lang: "en", paired: true, status: "offline", snapshot: c.snapshot(), approvals: [] });
    expect(off.chatEnabled).toBe(false);
    expect(off.title).toBe(en.newChat);
    c.setServerInfo({ serverVersion: "0.5.4-beta.1" });
    c.setOnline(true);
    c.handleFrame({ type: "models", requestId: "m", items: [] });
    const old =buildChatState({ lang: "en", paired: true, status: "online", snapshot: c.snapshot(), approvals: [] });
    expect(old.chatEnabled).toBe(false);
    expect(old.banner?.kind).toBe("unsupported");
  });

  it("lists conversations with relative times, approval labels and the current flag", () => {
    const c = createChatController({ send: () => true, roots: () => ["/w"], onChange: () => undefined });
    c.setOnline(true);
    const now = new Date(2026, 9, 21, 12, 0).getTime();
    c.handleFrame({
      type: "conversations",
      requestId: "l",
      items: [
        { id: "a", title: "", updatedAt: now - 5 * 60_000, approvalMode: "full", cwd: "/w" },
        { id: "b", title: "Refactor", updatedAt: now - 86_400_000 * 2, approvalMode: "auto", cwd: "/w" },
      ],
    });
    c.openConversation("b");
    const state = buildChatState({ lang: "en", paired: true, status: "online", snapshot: c.snapshot(), approvals: [], now });
    expect(state.recent).toEqual([
      {
        id: "a",
        title: en.untitled,
        updatedAt: now - 5 * 60_000,
        relative: "5m ago",
        approvalMode: "full",
        approvalLabel: en.modeFull,
        current: false,
      },
      {
        id: "b",
        title: "Refactor",
        updatedAt: now - 86_400_000 * 2,
        relative: "2d ago",
        approvalMode: "auto",
        approvalLabel: en.modeAuto,
        current: true,
      },
    ]);
    expect(state.title).toBe("Refactor");
  });

  it("localises errors, keeping server text only for generic errors", () => {
    const sent: Array<{ type: string; requestId?: string }> = [];
    const c = createChatController({
      send: (f) => {
        sent.push(f);
        return true;
      },
      roots: () => ["/w"],
      onChange: () => undefined,
    });
    c.setOnline(true);
    c.handleFrame({ type: "models", requestId: "m", items: [] });
    c.sendPrompt("x");
    const text = (): string | null =>
      buildChatState({ lang: "en", paired: true, status: "online", snapshot: c.snapshot(), approvals: [] }).errorText;
    expect(text()).toBe(en.errors.no_models);
    c.handleFrame({ type: "models", requestId: "m", items: [{ ref: "p::a", label: "A", provider: "P" }] });
    c.sendPrompt("x");
    const prompts = sent.filter((f) => f.type === "prompt");
    const requestId = prompts[prompts.length - 1]?.requestId ?? "";
    c.handleFrame({ type: "prompt_ack", requestId, ok: false, error: "weird", message: "server says no" });
    expect(text()).toBe("server says no");
    expect(en.errors.timeout).toContain("10 s");
  });

  it("parses copy and refreshHistory messages", () => {
    expect(parseChatMessage({ type: "refreshHistory" })).toEqual({ type: "refreshHistory" });
    expect(parseChatMessage({ type: "copy", text: "code" })).toEqual({ type: "copy", text: "code" });
    expect(parseChatMessage({ type: "copy", text: "" })).toBeNull();
    expect(parseChatMessage({ type: "copy", text: "x".repeat(200_001) })).toBeNull();
    expect(parseChatMessage({ type: "copy" })).toBeNull();
  });
});

describe("settings model", () => {
  const values = {
    serverUrl: "https://x.example",
    deviceName: "pc",
    theme: "astral",
    decorations: "off",
    autoSave: false,
    shell: "",
  } as const;

  it("builds state without any token field", () => {
    const state = buildSettingsState({ lang: "ja", version: "0.2.0", paired: true, status: "online", trusted: false, values });
    expect(state).toMatchObject({ serverUrl: "https://x.example", theme: "astral", paired: true, trusted: false });
    expect(JSON.stringify(state).toLowerCase()).not.toContain("token\":\"");
    expect(Object.keys(state)).not.toContain("token");
  });

  it("validates every setting", () => {
    expect(validateSetting("serverUrl", " https://omni.example/ ")).toBe("https://omni.example");
    expect(validateSetting("serverUrl", "")).toBe("");
    expect(validateSetting("serverUrl", "http://evil.example")).toBeNull();
    expect(validateSetting("serverUrl", "http://localhost:3000")).toBe("http://localhost:3000");
    expect(validateSetting("deviceName", "  my pc ")).toBe("my pc");
    expect(validateSetting("deviceName", "x".repeat(65))).toBeNull();
    expect(validateSetting("deviceName", "a\nb")).toBeNull();
    expect(validateSetting("theme", "astral")).toBe("astral");
    expect(validateSetting("theme", "neon")).toBeNull();
    expect(validateSetting("decorations", "auto")).toBe("auto");
    expect(validateSetting("decorations", "maybe")).toBeNull();
    expect(validateSetting("autoSave", true)).toBe(true);
    expect(validateSetting("autoSave", "true")).toBeNull();
    expect(validateSetting("shell", "/bin/zsh")).toBe("/bin/zsh");
  });

  it("parses messages and flags invalid values", () => {
    expect(parseSettingsMessage({ type: "set", key: "theme", value: "simple" })).toEqual({ type: "set", key: "theme", value: "simple" });
    expect(parseSettingsMessage({ type: "set", key: "theme", value: "x" })).toEqual({ type: "invalid", key: "theme" });
    expect(parseSettingsMessage({ type: "set", key: "token", value: "x" })).toBeNull();
    expect(parseSettingsMessage({ type: "set", key: "__proto__", value: "x" })).toBeNull();
    expect(parseSettingsMessage({ type: "unpair" })).toEqual({ type: "unpair" });
    expect(parseSettingsMessage({ type: "pair", code: "abc" })).toEqual({ type: "pair", code: "abc" });
    expect(parseSettingsMessage({ type: "pair", code: 1 })).toBeNull();
    expect(parseSettingsMessage(null)).toBeNull();
  });
});
