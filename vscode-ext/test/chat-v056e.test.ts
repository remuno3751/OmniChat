import { describe, expect, it } from "vitest";
import { createChatController, type ChatController } from "../src/chat/controller";
import { createCheckpointsHost } from "../src/chat/checkpointsHost";
import { cutFromLastUser } from "../src/chat/editLast";
import { buildChatState, parseChatMessage } from "../src/chat/viewModel";
import { checkpointTimeLabel } from "../src/chat/viewModelV056e";
import type { CheckpointItem, PromptAttachment, TranscriptItem } from "../src/protocol/chat-frames";
import {
  httpUrl, isValidCheckpointItem, isValidCheckpointRestoredFrame, isValidCheckpointsFrame, MAX_CHECKPOINTS,
  MAX_SOURCES, sanitizeSources,
} from "../src/protocol/chat-frames-v056e";
import { decode, encode } from "../src/protocol/codec";
import type { Frame, FrameType } from "../src/protocol/frames";
import { stringsFor, type Strings } from "../src/ui/strings";
import { v056eEn, v056eJa } from "../src/ui/stringsV056e";

const MODEL = { ref: "p::a", label: "A", provider: "P" };
const NOW = new Date(2026, 9, 24, 20, 0).getTime();
const T_TODAY = new Date(2026, 9, 24, 9, 5).getTime();
const CP: CheckpointItem = { id: "cp1", createdAt: T_TODAY, dirty: false, restorable: true, prompt: "fix the bug", files: 2, messageId: "a1" };
const ITEMS: TranscriptItem[] = [
  { kind: "user", id: "u1", text: "first" },
  { kind: "assistant", id: "a1", text: "answer", status: "done" },
  { kind: "user", id: "u2", text: "second" },
  { kind: "assistant", id: "a2", text: "answer 2", status: "done" },
];

/** A live controller on conversation c1 with the transcript ITEMS loaded. */
function setup() {
  const sent: Frame[] = [];
  let changes = 0;
  const c: ChatController = createChatController({
    send: (f) => (sent.push(f), true),
    roots: () => ["/work/app"],
    onChange: () => void changes++,
    now: () => NOW,
  });
  c.setOnline(true);
  c.handleFrame({ type: "models", requestId: "m0", items: [MODEL] });
  c.openConversation("c1");
  c.handleFrame({ type: "transcript", conversationId: "c1", reset: true, items: ITEMS });
  const lastRequestId = (): string => (sent[sent.length - 1] as { requestId: string }).requestId;
  return { c, sent, lastRequestId, changes: () => changes };
}

describe("codec: v0.5.6-E frames", () => {
  it("FrameType names the four new frame types", () => {
    const names: FrameType[] = ["checkpoints_request", "checkpoint_restore", "checkpoints", "checkpoint_restored"];
    expect(names).toHaveLength(4);
  });
  it("decodes the server's checkpoints and checkpoint_restored frames", () => {
    const list = { type: "checkpoints", requestId: "h1", conversationId: "c1", items: [CP] };
    expect(decode(JSON.stringify(list))).toEqual(list);
    const done = { type: "checkpoint_restored", requestId: "r1", conversationId: "c1", checkpointId: "cp1", ok: false, error: "dirty_editors" };
    expect(decode(JSON.stringify(done))).toEqual(done);
  });

  it("accepts the extension's request frames and encodes replaceLast", () => {
    const req = { type: "checkpoints_request", requestId: "h1", conversationId: "c1" };
    expect(decode(JSON.stringify(req))).toEqual(req);
    const restore = { type: "checkpoint_restore", requestId: "r1", conversationId: "c1", checkpointId: "cp1", removeNew: true };
    expect(decode(JSON.stringify(restore))).toEqual(restore);
    expect(encode({ type: "prompt", requestId: "p1", cwd: "/w", text: "x", conversationId: "c1", replaceLast: true })).toContain('"replaceLast":true');
  });

  it("drops malformed checkpoint frames", () => {
    const bad = { type: "checkpoints", requestId: "h1", conversationId: "c1", items: [{ ...CP, restorable: "yes" }] };
    expect(decode(JSON.stringify(bad))).toBeNull();
    const tooMany = { type: "checkpoints", requestId: "h1", conversationId: "c1", items: Array.from({ length: MAX_CHECKPOINTS + 1 }, () => CP) };
    expect(decode(JSON.stringify(tooMany))).toBeNull();
    expect(decode(JSON.stringify({ type: "checkpoint_restored", requestId: "r1", conversationId: "c1", checkpointId: "cp1" }))).toBeNull();
  });

  it("validators check each field and keep unknown extra fields", () => {
    expect(isValidCheckpointItem({ ...CP, extra: 1 })).toBe(true);
    expect(isValidCheckpointItem({ ...CP, files: "2" })).toBe(false);
    expect(isValidCheckpointsFrame({ requestId: "h", conversationId: "c", items: [] })).toBe(true);
    expect(isValidCheckpointsFrame({ requestId: "", conversationId: "c", items: [] })).toBe(false);
    expect(isValidCheckpointRestoredFrame({ requestId: "r", conversationId: "c", checkpointId: "x", ok: true })).toBe(true);
    expect(isValidCheckpointRestoredFrame({ requestId: "r", conversationId: "c", checkpointId: "x", ok: true, error: 3 })).toBe(false);
  });
});

describe("sources", () => {
  it("keeps http and https entries, drops the rest, and cleans the URL", () => {
    const out = sanitizeSources([
      { title: "  Docs  ", url: "https://a.example/x#frag", host: "ignored" },
      { title: "js", url: "javascript:alert(1)" },
      { title: "creds", url: "https://user:pw@b.example/" },
      { title: "ftp", url: "ftp://c.example/file" },
      { title: "bad", url: "not a url" },
      "plain string",
      { url: "http://d.example/y" },
    ]);
    expect(out).toEqual([
      { title: "Docs", url: "https://a.example/x", host: "a.example" },
      { title: "d.example", url: "http://d.example/y", host: "d.example" },
    ]);
  });

  it("keeps at most MAX_SOURCES and titles at most 200 characters", () => {
    const out = sanitizeSources(Array.from({ length: 12 }, (_, i) => ({ title: "t".repeat(300), url: `https://s${i}.example/` })));
    expect(out).toHaveLength(MAX_SOURCES);
    expect(out[0]?.title.length).toBe(200);
    expect(sanitizeSources("nope")).toEqual([]);
  });

  it("httpUrl refuses other schemes, user info and very long URLs", () => {
    expect(httpUrl("https://ok.example/path")).toBe("https://ok.example/path");
    expect(httpUrl("file:///etc/passwd")).toBeNull();
    expect(httpUrl("https://u@ok.example/")).toBeNull();
    expect(httpUrl(`https://ok.example/${"a".repeat(600)}`)).toBeNull();
  });

  it("the codec drops bad sources but keeps the assistant item", () => {
    const frame = {
      type: "transcript",
      conversationId: "c1",
      items: [
        { kind: "assistant", id: "a1", text: "t", status: "done", sources: [{ title: "x", url: "javascript:1" }, { title: "ok", url: "https://ok.example/" }] },
        { kind: "assistant", id: "a2", text: "t", status: "done", sources: [{ title: "x", url: "javascript:1" }] },
        { kind: "assistant", id: "a3", text: "t", status: "done", sources: "garbage" },
      ],
    };
    const got = decode(JSON.stringify(frame)) as { items: Array<{ id: string; sources?: unknown }> } | null;
    expect(got?.items.map((i) => i.id)).toEqual(["a1", "a2", "a3"]);
    expect(got?.items[0]?.sources).toEqual([{ title: "ok", url: "https://ok.example/", host: "ok.example" }]);
    expect(got?.items[1]?.sources).toBeUndefined();
    expect(got?.items[2]?.sources).toBeUndefined();
  });
});

describe("messages", () => {
  it("parses the checkpoint and external link messages", () => {
    expect(parseChatMessage({ type: "requestCheckpoints" })).toEqual({ type: "requestCheckpoints" });
    expect(parseChatMessage({ type: "restoreCheckpoint", checkpointId: "cp1" })).toEqual({ type: "restoreCheckpoint", checkpointId: "cp1" });
    expect(parseChatMessage({ type: "restoreCheckpoint" })).toBeNull();
    expect(parseChatMessage({ type: "restoreCheckpoint", checkpointId: "" })).toBeNull();
    expect(parseChatMessage({ type: "openExternal", url: "https://ok.example/" })).toEqual({ type: "openExternal", url: "https://ok.example/" });
    expect(parseChatMessage({ type: "openExternal", url: "javascript:alert(1)" })).toBeNull();
    expect(parseChatMessage({ type: "openExternal", url: 5 })).toBeNull();
  });

  it("keeps replaceLast on send and sendInterrupt only when it is true", () => {
    expect(parseChatMessage({ type: "send", text: "hi", replaceLast: true })).toEqual({ type: "send", text: "hi", replaceLast: true });
    expect(parseChatMessage({ type: "sendInterrupt", text: "hi", replaceLast: true })).toEqual({ type: "sendInterrupt", text: "hi", replaceLast: true });
    expect(parseChatMessage({ type: "send", text: "hi", replaceLast: "yes" })).toEqual({ type: "send", text: "hi" });
    expect(parseChatMessage({ type: "send", text: "hi" })).toEqual({ type: "send", text: "hi" });
  });
});

describe("controller: checkpoint list and replaceLast", () => {
  it("requests the list, shows it, and shows an error when the server answers with one", () => {
    const { c, sent, lastRequestId } = setup();
    c.checkpoints.request();
    expect(sent.at(-1)).toMatchObject({ type: "checkpoints_request", conversationId: "c1" });
    expect(c.snapshot().checkpoints.state).toBe("loading");
    c.handleFrame({ type: "checkpoints", requestId: lastRequestId(), conversationId: "c1", items: [CP] });
    expect(c.snapshot().checkpoints).toMatchObject({ state: "ready", items: [CP], restoring: null });

    c.checkpoints.request();
    c.handleFrame({ type: "error", code: "not_found", requestId: lastRequestId() });
    expect(c.snapshot().checkpoints).toMatchObject({ state: "error", items: [] });
  });

  it("a list for another conversation is not shown in the panel state", () => {
    const { c, lastRequestId } = setup();
    c.checkpoints.request();
    c.openConversation("c2");
    c.handleFrame({ type: "checkpoints", requestId: lastRequestId(), conversationId: "c1", items: [CP] });
    const view = buildChatState({ lang: "en", paired: true, status: "online", snapshot: c.snapshot(), approvals: [] }).v056e;
    expect(view.checkpoints).toEqual({ state: "idle", items: [], restoring: null, error: null });
  });

  it("replaceLast reaches the prompt frame and cuts the local transcript from the last user item", () => {
    const { c, sent } = setup();
    expect(c.sendPrompt("second", { replaceLast: true })).toBe(true);
    expect(sent.at(-1)).toMatchObject({ type: "prompt", conversationId: "c1", text: "second", replaceLast: true });
    expect(c.snapshot().items.map((i) => i.id)).toEqual(["u1", "a1"]);
  });

  it("a normal prompt carries no replaceLast, and replaceLast is refused while a run is active", () => {
    const { c, sent, lastRequestId } = setup();
    c.sendPrompt("more");
    expect(sent.at(-1)).not.toHaveProperty("replaceLast");
    c.handleFrame({ type: "prompt_ack", requestId: lastRequestId(), ok: true, conversationId: "c1" });
    const before = sent.length;
    expect(c.sendPrompt("edited", { replaceLast: true })).toBe(false);
    expect(sent.length).toBe(before);
    expect(c.snapshot().queue).toEqual([]);
  });

  it("cutFromLastUser keeps everything before the last user item", () => {
    expect(cutFromLastUser(ITEMS).map((i) => i.id)).toEqual(["u1", "a1"]);
    expect(cutFromLastUser([{ kind: "status", text: "x" }])).toEqual([{ kind: "status", text: "x" }]);
  });
});

describe("checkpoints host: confirm, cancel and result", () => {
  const s: Strings = stringsFor("ja");
  function host(answer: string | undefined) {
    const t = setup();
    t.c.checkpoints.request();
    t.c.handleFrame({ type: "checkpoints", requestId: t.lastRequestId(), conversationId: "c1", items: [CP] });
    const asked: Array<{ message: string; buttons: string[] }> = [];
    const toasts: string[] = [];
    const h = createCheckpointsHost({
      controller: t.c,
      strings: s,
      now: () => NOW,
      confirm: (message, buttons) => (asked.push({ message, buttons }), Promise.resolve(answer)),
      toast: (text) => toasts.push(text),
    });
    const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
    return { ...t, h, asked, toasts, flush };
  }

  it("asks with the time and the prompt, and sends nothing when cancelled", async () => {
    const t = host(undefined);
    t.h.restore("cp1"); await t.flush();
    expect(t.asked).toHaveLength(1);
    expect(t.asked[0]?.message).toContain("09:05");
    expect(t.asked[0]?.message).toContain("fix the bug");
    expect(t.asked[0]?.message).not.toContain("{");
    expect(t.asked[0]?.buttons).toEqual([s.cpConfirmRestore, s.cpConfirmRestoreRemove]);
    expect(t.sent.some((f) => f.type === "checkpoint_restore")).toBe(false);
  });

  it("sends the restore, and removeNew only for the second button", async () => {
    const plain = host(stringsFor("ja").cpConfirmRestore);
    plain.h.restore("cp1"); await plain.flush();
    expect(plain.sent.at(-1)).toMatchObject({ type: "checkpoint_restore", conversationId: "c1", checkpointId: "cp1" });
    expect(plain.sent.at(-1)).not.toHaveProperty("removeNew");

    const remove = host(s.cpConfirmRestoreRemove);
    remove.h.restore("cp1"); await remove.flush();
    expect(remove.sent.at(-1)).toMatchObject({ type: "checkpoint_restore", removeNew: true });
  });

  it("on success: toast, a local status line, and a fresh list", async () => {
    const t = host(s.cpConfirmRestore);
    t.h.restore("cp1"); await t.flush();
    t.c.handleFrame({ type: "checkpoint_restored", requestId: t.lastRequestId(), conversationId: "c1", checkpointId: "cp1", ok: true });
    expect(t.toasts).toEqual([s.cpRestored.replace("{time}", "09:05")]);
    expect(t.c.snapshot().items.at(-1)).toEqual({ kind: "status", text: s.cpRestored.replace("{time}", "09:05") });
    expect(t.sent.at(-1)).toMatchObject({ type: "checkpoints_request" });
  });

  it("on failure: a toast with the reason and no status line", async () => {
    const t = host(s.cpConfirmRestore);
    t.h.restore("cp1"); await t.flush();
    t.c.handleFrame({ type: "checkpoint_restored", requestId: t.lastRequestId(), conversationId: "c1", checkpointId: "cp1", ok: false, error: "dirty_editors" });
    expect(t.toasts).toEqual([s.cpDirtyEditors]);

    expect(t.c.snapshot().items).toHaveLength(ITEMS.length);
    expect(t.c.snapshot().checkpoints.restoring).toBeNull();
  });

  it("a server error answering a restore is toasted with its reason", async () => {
    const t = host(s.cpConfirmRestore);
    t.h.restore("cp1"); await t.flush();
    t.c.handleFrame({ type: "error", code: "busy", requestId: t.lastRequestId() });
    expect(t.toasts).toEqual([s.cpBusy]);
    expect(t.c.snapshot().checkpoints.restoring).toBeNull();
  });

  it("refuses without asking for a run in progress or an unrestorable point", async () => {
    const t = host(s.cpConfirmRestore);
    t.c.checkpoints.request();
    t.c.handleFrame({ type: "checkpoints", requestId: t.lastRequestId(), conversationId: "c1", items: [{ ...CP, id: "cp2", restorable: false }] });
    t.h.restore("cp2");
    expect(t.toasts).toEqual([s.cpUnavailable]);
    t.h.restore("missing");
    expect(t.asked).toHaveLength(0);
  });
});

describe("time label and strings", () => {
  it("shows HH:mm for today and M/D HH:mm for another day", () => {
    expect(checkpointTimeLabel(T_TODAY, NOW)).toBe("09:05");
    expect(checkpointTimeLabel(new Date(2026, 9, 23, 9, 5).getTime(), NOW)).toBe("10/23 09:05");
  });

  it("Japanese and English have the same v0.5.6-E keys, all filled", () => {
    expect(Object.keys(v056eEn).sort()).toEqual(Object.keys(v056eJa).sort());
    for (const key of Object.keys(v056eJa) as Array<keyof typeof v056eJa>) {
      expect(v056eJa[key], key).toBeTruthy();
      expect(v056eEn[key], key).toBeTruthy();
    }
    for (const key of ["cpTitle", "cpConfirm", "cpRestored", "cpFailed", "srcTitle", "editBusy", "editBannerText"] as const) {
      expect(stringsFor("en")[key], key).toBe(v056eEn[key]);
    }
  });

  it("send accepts replaceLast together with attachments", () => {
    const file: PromptAttachment = { name: "a.txt", mime: "text/plain", data: "aGk=" };
    expect(parseChatMessage({ type: "send", text: "x", attachments: [file], replaceLast: true })).toMatchObject({ replaceLast: true });
  });
});
