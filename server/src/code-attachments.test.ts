// Attachments in Code (dsh-bridge) conversations: documents reach the bridge as text, images and audio are refused,
// other users' attachments are refused. A fake bridge records the `run` frame. (docs/design/ATTACHMENTS.md, "Code / DSH での添付")
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
import JSZip from "jszip";

const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const PW = "password123";
let child: ChildProcess;
let port = 0;
let tmp = "";
let base = "";
let tok = "";
let otherTok = "";

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
async function api(method: string, path: string, body?: unknown, t = tok) {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
}
/** Uploads the bytes as one attachment (the body is the file itself). Returns the id. */
async function upload(name: string, mime: string, bytes: Buffer, t = tok): Promise<string> {
  await sleep(60);
  const r = await fetch(base + "/attachments", {
    method: "POST",
    headers: { "content-type": mime, "x-file-name": encodeURIComponent(name), authorization: `Bearer ${t}` },
    body: new Uint8Array(bytes),
  });
  const j = (await r.json().catch(() => null)) as any;
  assert.equal(r.status, 200, `upload ${name}: ${JSON.stringify(j)}`);
  return j.attachment.id as string;
}
function open(url: string): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.once("open", () => res(ws));
    ws.once("error", rej);
    ws.once("unexpected-response", (_q, resp) => rej(new Error("HTTP " + resp.statusCode)));
  });
}
/** Creates a dsh-bridge provider (bridge name = bridgeName) and a conversation in mode "code". */
async function mkCodeConv(bridgeName: string): Promise<string> {
  const id = randomUUID();
  const prov = randomUUID();
  const p = await api("PUT", `/providers/${prov}`, { name: bridgeName, kind: "dsh-bridge", baseUrl: bridgeName, model: "x" });
  assert.equal(p.status, 200, "provider create");
  const r = await api("PUT", `/conversations/${id}`, { providerId: prov, mode: "code" });
  assert.equal(r.status, 200, "conversation create");
  return id;
}

/** A user's socket: collects every frame. */
async function userSocket(t = tok) {
  const ws = await open(`ws://127.0.0.1:${port}/ws?token=${t}`);
  const frames: any[] = [];
  ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  return { ws, frames };
}
/** Sends a `send` frame and returns the userMessageId used. */
function send(ws: WebSocket, conversationId: string, content: string, attachmentIds?: string[]) {
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  ws.send(JSON.stringify({
    type: "send", conversationId, content, userMessageId, assistantMessageId,
    ...(attachmentIds ? { attachmentIds } : {}),
  }));
  return { userMessageId, assistantMessageId };
}

let runs: any[] = [];
let bridge: WebSocket;
let codeConv = "";
let user: { ws: WebSocket; frames: any[] };

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "omni-code-att-"));
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    windowsHide: true,
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: join(tmp, "t.db"),
      DATA_DIR: join(tmp, "data"),
      OMNICHAT_OPEN_FIRST_REGISTRATION: "1",
      ALLOW_REGISTRATION: "1",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((res, rej) => {
    child.stdout!.on("data", (d) => { if (String(d).includes("listening")) res(); });
    child.once("exit", () => rej(new Error("server exited")));
  });
  tok = (await api("POST", "/auth/register", { username: "tester", password: PW, deviceName: "t", platform: "test" }, "")).json.token;
  otherTok = (await api("POST", "/auth/register", { username: "other", password: PW, deviceName: "t", platform: "test" }, "")).json.token;
  assert.ok(tok && otherTok, "registration");

  // A fake bridge named "codepc": records every `run` frame and finishes the run at once (done, ok, no text).
  bridge = await open(`ws://127.0.0.1:${port}/bridge?token=${tok}&name=codepc`);
  bridge.send(JSON.stringify({ type: "ready", name: "codepc", cwd: "C:\\work\\proj" }));
  bridge.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type !== "run") return;
    runs.push(m);
    bridge.send(JSON.stringify({ type: "done", runId: m.runId, ok: true, sessionId: "s-test" }));
  });
  await sleep(120);
  codeConv = await mkCodeConv("codepc");
  user = await userSocket();
});

after(async () => {
  try { user?.ws.close(); bridge?.close(); } catch { /* ignore */ }
  if (child && child.exitCode === null) {
    const exited = new Promise((res) => child.once("exit", res));
    child.kill();
    await exited; // Windows keeps the sqlite file locked until the server has gone
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir cleaned by the OS */ }
});

async function docxBytes(paragraph: string): Promise<Buffer> {
  const z = new JSZip();
  z.file("[Content_Types].xml", "<Types/>");
  z.file("word/document.xml", `<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p></w:body></w:document>`);
  return z.generateAsync({ type: "nodebuffer" });
}

test("a docx and a md attachment reach the bridge prompt as text blocks before the user text", async () => {
  const docx = await upload("spec.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", await docxBytes("本文テスト"));
  const md = await upload("notes.md", "text/markdown", Buffer.from("# Notes\nhello md\n", "utf8"));
  const before = runs.length;
  send(user.ws, codeConv, "この資料を要約して", [docx, md]);
  await until(() => runs.length > before);
  const prompt: string = runs[runs.length - 1].prompt;
  assert.ok(prompt.includes("[添付: spec.docx]\n"), prompt);
  assert.ok(prompt.includes("本文テスト"), prompt);
  assert.ok(prompt.includes("[添付: notes.md]\n# Notes\nhello md"), prompt);
  assert.ok(prompt.endsWith("この資料を要約して"), prompt);
  assert.ok(prompt.indexOf("[添付: spec.docx]") < prompt.indexOf("この資料を要約して"));
});

test("an image in a Code conversation is refused with attachment_not_supported_in_code and nothing runs", async () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc00000030101005c7d3ad90000000049454e44ae426082", "hex");
  const img = await upload("pic.png", "image/png", png);
  const before = runs.length;
  const sent = send(user.ws, codeConv, "これを見て", [img]);
  await until(() => user.frames.some((f) => f.type === "error" && f.messageId === sent.assistantMessageId));
  const err = user.frames.find((f) => f.type === "error" && f.messageId === sent.assistantMessageId);
  assert.equal(err.code, "attachment_invalid");
  assert.match(err.message, /^attachment_not_supported_in_code: /);
  await sleep(150);
  assert.equal(runs.length, before, "no run frame for a refused message");
});

test("an audio attachment is refused the same way", async () => {
  const wav = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WAVEfmt ", "ascii"), Buffer.alloc(40)]);
  const aud = await upload("voice.wav", "audio/wav", wav);
  const sent = send(user.ws, codeConv, "聞いて", [aud]);
  await until(() => user.frames.some((f) => f.type === "error" && f.messageId === sent.assistantMessageId));
  const err = user.frames.find((f) => f.type === "error" && f.messageId === sent.assistantMessageId);
  assert.match(err.message, /^attachment_not_supported_in_code/);
});

test("another user's attachment id is refused", async () => {
  const mine = await upload("private.md", "text/markdown", Buffer.from("secret\n", "utf8"), otherTok);
  const sent = send(user.ws, codeConv, "読んで", [mine]);
  await until(() => user.frames.some((f) => f.type === "error" && f.messageId === sent.assistantMessageId));
  const err = user.frames.find((f) => f.type === "error" && f.messageId === sent.assistantMessageId);
  assert.match(err.message, /^attachment_not_found/);
});

test("the document text of one Code message is held to one extractMaxChars budget (60000 by default)", async () => {
  const big = "a".repeat(40000);
  const one = await upload("big1.txt", "text/plain", Buffer.from(big, "utf8"));
  const two = await upload("big2.txt", "text/plain", Buffer.from("b".repeat(40000), "utf8"));
  const before = runs.length;
  send(user.ws, codeConv, "続き", [one, two]);
  await until(() => runs.length > before);
  const prompt: string = runs[runs.length - 1].prompt;
  assert.ok(prompt.includes("[添付: big1.txt]\n" + big + "\n"), "first document in full");
  assert.ok(prompt.includes("[添付: big2.txt]\n" + "b".repeat(20000) + "\n(以下省略: 全 40000 文字中 20000 文字)"), "second document cut to the rest");
  assert.ok(prompt.endsWith("続き"));
});
