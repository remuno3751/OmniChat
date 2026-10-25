// Live transcript for the VS Code chat panel (docs/design/V055-CONTRACT.md v0.5.5-a): tool diffs and assistant delta frames.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import WebSocket from "ws";

process.env.DB_PATH = ":memory:";
const bridges = await import("./bridges.js");
const auth = await import("./auth.js");
const vb = await import("./vscode-bridge.js");
const tr = await import("./vscode-transcript.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 4000) => {
  const t = Date.now();
  while (!f()) { if (Date.now() - t > ms) throw new Error("timeout waiting"); await sleep(10); }
};

/* ---------- buildDiff / toolItem (pure) ---------- */

test("buildDiff edit_file: changed line with up to 2 context lines each side", () => {
  const d = tr.buildDiff("edit_file", { path: "a.ts", oldString: "a\nb\nc\nd\ne", newString: "a\nb\nX\nd\ne" });
  assert.deepEqual(d, { path: "a.ts", added: 1, removed: 1, lines: [" a", " b", "-c", "+X", " d", " e"] });
});

test("buildDiff edit_file: context stops at 2 lines, the rest is left out", () => {
  const old = ["1", "2", "3", "4", "5", "6", "7"].join("\n");
  const d = tr.buildDiff("edit_file", { path: "n.txt", oldString: old, newString: old.replace("7", "seven") });
  assert.deepEqual(d?.lines, [" 5", " 6", "-7", "+seven"]);
  assert.equal(d?.removed, 1);
  assert.equal(d?.added, 1);
});

test("buildDiff write_file: every line is added, trailing newline ignored", () => {
  assert.deepEqual(tr.buildDiff("write_file", { path: "w.md", content: "x\ny\n" }), { path: "w.md", added: 2, removed: 0, lines: ["+x", "+y"] });
  assert.deepEqual(tr.buildDiff("write_file", { path: "e.md", content: "" }), undefined);
});

test("buildDiff: no diff for other tools, no change, or bad arguments", () => {
  assert.equal(tr.buildDiff("run_command", { path: "x", command: "ls" }), undefined);
  assert.equal(tr.buildDiff("edit_file", { path: "a", oldString: "same", newString: "same" }), undefined);
  assert.equal(tr.buildDiff("edit_file", { path: "a", oldString: 1, newString: "x" }), undefined);
  assert.equal(tr.buildDiff("write_file", { content: "x" }), undefined);
});

test("buildDiff: at most 200 lines and 300 chars per line, truncated when cut", () => {
  const many = tr.buildDiff("write_file", { path: "big.txt", content: Array.from({ length: 250 }, (_, i) => `l${i}`).join("\n") });
  assert.equal(many?.added, 250);
  assert.equal(many?.lines.length, 200);
  assert.equal(many?.truncated, true);
  const long = tr.buildDiff("write_file", { path: "long.txt", content: "y".repeat(400) });
  assert.equal(long?.lines[0].length, 300);
  assert.equal(long?.truncated, true);
  assert.equal(tr.buildDiff("write_file", { path: "ok.txt", content: "a\nb" })?.truncated, undefined);
});

test("toolItem: diff for edit/write calls that ran, none for denied or failed calls", () => {
  const base = { id: "c1", name: "edit_file", arguments: { path: "a.ts", oldString: "a", newString: "b" }, decidedBy: undefined, durationMs: 3 };
  const done = tr.toolItem("m1", { ...base, status: "done" }) as any;
  assert.equal(done.id, "m1:c1");
  assert.equal(done.diff.added, 1);
  assert.equal(done.durationMs, 3);
  assert.equal((tr.toolItem("m1", { ...base, status: "denied" }) as any).diff, undefined);
  assert.equal((tr.toolItem("m1", { ...base, status: "error" }) as any).diff, undefined);
  assert.equal((tr.toolItem("m1", { ...base, status: "running" }) as any).diff?.removed, 1);
});

/* ---------- delta frames through the bridge (fake extension) ---------- */

let server: Server;
let port = 0;
let userId = "";
let token = "";
const open: WebSocket[] = [];

/** A fake extension: connects to the bridge, says ready with the given capabilities, records every frame. */
async function connect(instance: string, caps: Record<string, unknown>) {
  const q = new URLSearchParams({ token, name: "lab", kind: "vscode", instance });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge?${q}`);
  open.push(ws);
  const frames: any[] = [];
  ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  await new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); });
  ws.send(JSON.stringify({
    type: "ready", kind: "vscode", name: "lab", instance, version: "0.1.0", protocol: 1, vscodeVersion: "1.96.0", platform: "linux", shell: "bash",
    remote: null, cwd: "/work/app", workspaces: ["/work/app"], allowAnyCwd: false, trusted: true,
    capabilities: { workspaces: true, fs: false, approval: true, checkpoints: true, transcript: true, chat: true, tools: ["edit_file"], ...caps },
  }));
  await until(() => frames.some((f) => f.type === "welcome"));
  return frames;
}

/** Replays assistant items the way the extension does (S -> E delta rules). Returns the text + reasoning, or throws on a mismatch. */
function replay(items: any[]) {
  let text = "";
  let reasoning = "";
  for (const it of items) {
    if (it.from === undefined) { text = it.text; } else { assert.equal(text.length, it.from, "delta from must match"); text += it.text; }
    if (it.reasoning !== undefined) {
      if (it.reasoningFrom === undefined) reasoning = it.reasoning;
      else { assert.equal(reasoning.length, it.reasoningFrom, "reasoning delta from must match"); reasoning += it.reasoning; }
    }
  }
  return { text, reasoning };
}

before(async () => {
  const u = await auth.createUserDirect("transcriptuser", "password123", false);
  userId = u.userId;
  token = auth.createDevice(userId, "VS Code (t)", "vscode-ext").token;
  server = createServer();
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/bridge") return bridges.handleBridgeUpgrade(req, socket, head, url);
    socket.destroy();
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  port = (server.address() as any).port;
});
after(() => { for (const ws of open) try { ws.terminate(); } catch { /* ignore */ } server.close(); server.closeAllConnections?.(); });

test("sendToChatInstancesBy builds the frame per instance from transcriptDelta", async () => {
  const delta = await connect("td-a", { transcriptDelta: true });
  const plain = await connect("td-b", {});
  const n = vb.sendToChatInstancesBy(userId, "lab", (caps) => ({ type: "probe", caps }));
  assert.equal(n, 2);
  await until(() => delta.some((f) => f.type === "probe") && plain.some((f) => f.type === "probe"));
  assert.deepEqual(delta.find((f) => f.type === "probe").caps, { transcriptDelta: true });
  assert.deepEqual(plain.find((f) => f.type === "probe").caps, { transcriptDelta: false });
});

test("streaming answer: delta instances get suffixes after the first frame, others get full text; the final frame is full", async () => {
  const delta = await connect("fd-a", { transcriptDelta: true });
  const plain = await connect("fd-b", {});
  const start = { delta: delta.length, plain: plain.length };
  const feed = tr.beginTranscript({ userId, bridge: "lab", conversationId: "conv-delta", userMessageId: null, assistantMessageId: "asst-1" });
  feed.addText("Hel");
  await sleep(150);
  feed.addText("lo");
  await sleep(150);
  feed.addReasoning("think");
  await sleep(150);
  feed.end("done");
  await until(() => delta.slice(start.delta).some((f) => f.items?.some((i: any) => i.status === "done")));
  await until(() => plain.slice(start.plain).some((f) => f.items?.some((i: any) => i.status === "done")));

  const assistantOf = (frames: any[]) => frames.filter((f) => f.type === "transcript" && f.conversationId === "conv-delta").flatMap((f) => f.items).filter((i: any) => i.kind === "assistant");
  const dItems = assistantOf(delta.slice(start.delta));
  const pItems = assistantOf(plain.slice(start.plain));

  // the first frame is full, the middle ones are suffixes, the final one is full again
  assert.ok(dItems.length >= 3, "a streamed answer sends more than one frame");
  assert.equal(dItems[0].from, undefined);
  assert.equal(dItems[0].text, "Hel");
  assert.ok(dItems.slice(1, -1).every((i: any) => typeof i.from === "number"));
  assert.equal(dItems.at(-1).from, undefined);
  assert.equal(dItems.at(-1).status, "done");
  assert.deepEqual(replay(dItems), { text: "Hello", reasoning: "think" });

  // instances without transcriptDelta never see a `from`
  assert.ok(pItems.every((i: any) => i.from === undefined && i.reasoningFrom === undefined));
  assert.equal(pItems.at(-1).text, "Hello");
  assert.equal(pItems.at(-1).reasoning, "think");
});
