import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");
let child: ChildProcess;
let port = 0;
let tmp = "";
let base = "";
let token = "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 5000) => {
  const t = Date.now();
  while (!f()) { if (Date.now() - t > ms) throw new Error("timeout"); await sleep(20); }
};

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer().listen(0, () => { const p = (s.address() as any).port; s.close(() => res(p)); });
  });
}
async function api(method: string, path: string, body?: unknown, tok = token) {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
}
function open(url: string): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.once("open", () => res(ws));
    ws.once("error", rej);
    ws.once("unexpected-response", (_q, resp) => rej(new Error("HTTP " + resp.statusCode)));
  });
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "omni-"));
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { windowsHide: true,
    cwd: serverDir, env: { ...process.env, PORT: String(port), DB_PATH: join(tmp, "t.db") }, stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((res, rej) => {
    child.stdout!.on("data", (d) => { if (String(d).includes("listening")) res(); });
    child.once("exit", () => rej(new Error("server exited")));
  });
  const r = await api("POST", "/auth/register", { username: "tester", password: "password123" }, "");
  token = r.json.token;
});
after(() => { child?.kill(); try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

test("dsh-bridge end to end", async () => {
  assert.deepEqual((await api("GET", "/provider-kinds")).json.kinds.sort(), ["dsh-bridge", "openai-compatible"]);

  await assert.rejects(open(`ws://127.0.0.1:${port}/bridge?token=bad&name=pc`), /401/);

  // Fake bridge.
  const bws = await open(`ws://127.0.0.1:${port}/bridge?token=${token}&name=pc`);
  bws.send(JSON.stringify({ type: "ready", name: "pc", cwd: "C:\\work" }));
  const got: any[] = [];
  bws.on("message", (raw) => got.push(JSON.parse(raw.toString())));
  await until(() => true);
  await sleep(100);
  assert.deepEqual((await api("GET", "/bridges")).json, { bridges: [{ name: "pc", cwd: "C:\\work", online: true, workspacesSupported: false, workspaces: [], allowAnyCwd: false }] });

  const prov = randomUUID(), conv = randomUUID();
  await api("PUT", `/providers/${prov}`, { name: "PC", kind: "dsh-bridge", baseUrl: "pc", model: "x" });
  await api("PUT", `/conversations/${conv}`, { providerId: prov });

  const app = await open(`ws://127.0.0.1:${port}/ws?token=${token}`);
  const frames: any[] = [];
  app.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  const asstContent = (id: string) => {
    let c = "";
    for (const f of frames) if (f.type === "delta" && f.messageId === id && f.kind !== "reasoning") c += f.text;
    return c;
  };
  const lastUpsert = (id: string) => {
    let m: any;
    for (const f of frames) for (const x of f.messages ?? []) if (x.id === id) m = x;
    return m;
  };

  // Message 1.
  const a1 = randomUUID();
  app.send(JSON.stringify({ type: "send", conversationId: conv, content: "hello", userMessageId: randomUUID(), assistantMessageId: a1 }));
  await until(() => got.some((m) => m.type === "run"));
  const run1 = got.find((m) => m.type === "run");
  assert.equal(run1.prompt, "hello");
  assert.equal(run1.sessionId, null);
  const ev = (event: any) => bws.send(JSON.stringify({ type: "event", runId: run1.runId, event }));
  ev({ type: "session", sessionId: "session-1" });
  ev({ type: "status", phase: "turn_start" });
  ev({ type: "thinking", text: "hmm" });
  ev({ type: "text", text: "Hi " });
  ev({ type: "tool_call", callId: "c1", tool: "glob", input: { p: "*.ts" } });
  ev({ type: "tool_result", callId: "c1", status: "completed", result: "ok" });
  ev({ type: "tool_call", callId: "c2", tool: "shell", input: { cmd: "x" } });
  ev({ type: "tool_result", callId: "c2", status: "error", result: "boom" });
  ev({ type: "text", text: "done." });
  ev({ type: "final", text: "ignored" });
  bws.send(JSON.stringify({ type: "done", runId: run1.runId, ok: true, sessionId: "session-1" }));
  await until(() => lastUpsert(a1)?.status === "done");
  assert.equal(
    asstContent(a1),
    'Hi \n\n> \u{1F527} glob {"p":"*.ts"}\n\n\n\n> \u{1F527} shell {"cmd":"x"}\n\n> \u26A0\uFE0F shell failed: boom\n\ndone.',
  );
  assert.equal(lastUpsert(a1).content, asstContent(a1));

  // Message 2 reuses session, only latest message.
  const a2 = randomUUID();
  app.send(JSON.stringify({ type: "send", conversationId: conv, content: "again", userMessageId: randomUUID(), assistantMessageId: a2 }));
  await until(() => got.filter((m) => m.type === "run").length === 2);
  const run2 = got.filter((m) => m.type === "run")[1];
  assert.equal(run2.prompt, "again");
  assert.equal(run2.sessionId, "session-1");

  // Stop -> cancel.
  app.send(JSON.stringify({ type: "stop", messageId: a2 }));
  await until(() => got.some((m) => m.type === "cancel" && m.runId === run2.runId));
  bws.send(JSON.stringify({ type: "done", runId: run2.runId, ok: false, sessionId: "session-1", error: "cancelled" }));
  await until(() => lastUpsert(a2)?.status === "stopped");

  // Bridge dies mid-run -> error.
  const a3 = randomUUID();
  app.send(JSON.stringify({ type: "send", conversationId: conv, content: "third", userMessageId: randomUUID(), assistantMessageId: a3 }));
  await until(() => got.filter((m) => m.type === "run").length === 3);
  bws.close();
  await until(() => lastUpsert(a3)?.status === "error");
  assert.match(lastUpsert(a3).content, /disconnected/);

  // Offline.
  await sleep(100);
  const a4 = randomUUID();
  app.send(JSON.stringify({ type: "send", conversationId: conv, content: "x", userMessageId: randomUUID(), assistantMessageId: a4 }));
  await until(() => lastUpsert(a4)?.status === "error");
  assert.equal(lastUpsert(a4).content, "Bridge 'pc' is offline. Start the bridge on your PC.");
  assert.deepEqual((await api("GET", "/bridges")).json, { bridges: [] });
  app.close();
});
