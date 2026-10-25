import { describe, expect, it } from "vitest";
import { decode } from "../src/protocol/codec";
import { createChatController } from "../src/chat/controller";
import { buildContextView, buildChatState, formatTokens } from "../src/chat/viewModel";
import { stringsFor } from "../src/ui/strings";

const USED = { system: 1200, history: 9800, attachments: 0, tools: 2400, input: 150 };
const LAST = { prompt: 11_000, completion: 800, reasoning: 300 };

function ctxFrame(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "context", requestId: "c1", total: 13_550, limit: 128_000, fits: true, estimated: false, ...extra });
}

describe("context frame: optional breakdown fields", () => {
  const good = [
    ["without the breakdown", {}],
    ["with used, reasoning and last", { used: USED, reasoning: 300, last: LAST }],
    ["with only used", { used: USED }],
    ["with only last", { last: LAST }],
  ] as const;
  it.each(good)("accepts a context frame %s", (_name, extra) => {
    expect(decode(ctxFrame(extra))).not.toBeNull();
  });

  const bad = [
    ["used missing a part", { used: { ...USED, tools: undefined } }],
    ["used with a string count", { used: { ...USED, history: "9800" } }],
    ["used as null", { used: null }],
    ["reasoning as a string", { reasoning: "300" }],
    ["last missing completion", { last: { prompt: 1, reasoning: 0 } }],
    ["last as an array", { last: [1, 2, 3] }],
  ] as const;
  it.each(bad)("drops a context frame with a malformed field: %s", (_name, extra) => {
    expect(decode(ctxFrame(extra))).toBeNull();
  });
});

describe("controller: breakdown reaches the snapshot", () => {
  it("keeps used, reasoning and last on the snapshot when the server sent them", () => {
    const sent: string[] = [];
    const c = createChatController({
      send: (f) => (f.type === "context_request" && sent.push(f.requestId), true),
      roots: () => ["/w"],
      onChange: () => undefined,
    });
    c.setOnline(true);
    c.openConversation("c1");
    c.handleFrame({ type: "transcript", conversationId: "c1", reset: true, items: [] });
    c.refreshContext();
    const requestId = sent.at(-1) as string;
    c.handleFrame({ type: "context", requestId, total: 13_550, limit: 128_000, fits: true, estimated: false, used: USED, reasoning: 300, last: LAST });
    expect(c.snapshot().context).toEqual({ total: 13_550, limit: 128_000, fits: true, estimated: false, used: USED, reasoning: 300, last: LAST });
  });

  it("leaves the breakdown fields off when the server did not send them", () => {
    const sent: string[] = [];
    const c = createChatController({
      send: (f) => (f.type === "context_request" && sent.push(f.requestId), true),
      roots: () => ["/w"],
      onChange: () => undefined,
    });
    c.setOnline(true);
    c.openConversation("c1");
    c.handleFrame({ type: "transcript", conversationId: "c1", reset: true, items: [] });
    c.refreshContext();
    c.handleFrame({ type: "context", requestId: sent.at(-1) as string, total: 5, limit: 0, fits: true, estimated: true });
    expect(c.snapshot().context).toEqual({ total: 5, limit: 0, fits: true, estimated: true });
  });

});

describe("buildContextView: token breakdown", () => {
  const en = stringsFor("en");
  const full = { total: 13_550, limit: 128_000, fits: true, estimated: false, used: USED, reasoning: 300, last: LAST };

  it("has no breakdown when the server sent no used counts", () => {
    const view = buildContextView({ total: 13_550, limit: 128_000, fits: true, estimated: false }, en);
    expect(view).toMatchObject({ pct: 11, level: "ok" });
    expect(view).not.toHaveProperty("breakdown");
  });

  it("renders the rows, the reasoning and total rows, the last reply and the cache note", () => {
    const view = buildContextView(full, en);
    expect(view?.breakdown).toEqual({
      rows: [
        { label: "System", tokens: "1.2k" },
        { label: "History", tokens: "9.8k" },
        { label: "Attachments", tokens: "0" },
        { label: "Tools", tokens: "2.4k" },
        { label: "Draft", tokens: "150" },
        { label: "Reasoning", tokens: "300" },
        { label: "Total / limit", tokens: "13.6k / 128k" },
      ],
      lastRows: [
        { label: "Prompt", tokens: "11k" },
        { label: "Completion", tokens: "800" },
        { label: "Reasoning", tokens: "300" },
      ],
      cacheNote: en.tokCache,
      title: en.tokensTitle,
    });
  });

  it("leaves out the reasoning row and the last rows when the server did not send them", () => {
    const view = buildContextView({ total: 12_000, limit: 128_000, fits: true, estimated: false, used: USED }, en);
    expect(view?.breakdown?.rows.map((r) => r.label)).toEqual(["System", "History", "Attachments", "Tools", "Draft", "Total / limit"]);
    expect(view?.breakdown?.lastRows).toEqual([]);
  });

  it("shows only the total against an unknown limit", () => {
    const view = buildContextView({ total: 4_200, limit: 0, fits: true, estimated: true, used: USED }, en);
    expect(view?.text).toBe("~4.2k tokens");
    expect(view?.breakdown?.rows.at(-1)).toEqual({ label: "Total / limit", tokens: "4.2k" });
  });

  it("uses the Japanese labels in ja", () => {
    const ja = stringsFor("ja");
    const view = buildContextView(full, ja);
    expect(view?.breakdown?.title).toBe(ja.tokensTitle);
    expect(view?.breakdown?.rows[0]?.label).toBe(ja.tokSystem);
    expect(view?.breakdown?.cacheNote).toBe(ja.tokCache);
  });

  it("reaches the view state through buildChatState", () => {
    const c = createChatController({ send: () => true, roots: () => ["/w"], onChange: () => undefined });
    const state = buildChatState({
      lang: "en",
      paired: true,
      status: "online",
      snapshot: { ...c.snapshot(), context: full },
      approvals: [],
    });
    expect(state.context?.breakdown?.rows).toHaveLength(7);
    expect(formatTokens(13_550)).toBe("13.6k");
  });
});
