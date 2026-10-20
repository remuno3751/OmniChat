import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createNet, type AddressInfo } from "node:net";
import { createServer as createHttp, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");
let child: ChildProcess;
let base = "";
let wsUrl = "";
let token = "";
let tmp = "";
const servers: Server[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((res) => { const s = createNet().listen(0, () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); }); });
async function api(method: string, path: string, body?: unknown, tok = token) {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
}
async function listen(handler: (req: any, res: any, body: any) => void) {
  const calls: string[] = [];
  const srv = createHttp((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* */ }
      calls.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  servers.push(srv);
  return { port: (srv.address() as AddressInfo).port, calls };
}
const send = (res: any, o: unknown, code = 200) => { res.statusCode = code; res.end(JSON.stringify(o)); };

// Fake LM Studio: chat-a loaded, chat-b not, one embeddings model.
const lmHandler = (loaded: Set<string>, withV1: boolean) => (req: any, res: any, body: any) => {
  const u = req.url as string;
  if (u === "/v1/models") return send(res, { data: [{ id: "chat-a" }, { id: "chat-b" }, { id: "nomic-embed" }] });
  if (u === "/api/v0/models") return send(res, { data: [
    { id: "chat-a", type: "llm", state: loaded.has("chat-a") ? "loaded" : "not-loaded", quantization: "Q4_K_M", max_context_length: 4096, arch: "x" },
    { id: "chat-b", type: "vlm", state: loaded.has("chat-b") ? "loaded" : "not-loaded", quantization: "Q8_0", max_context_length: 8192 },
    { id: "nomic-embed", type: "embeddings", state: "not-loaded" },
  ] });
  if (withV1 && u === "/api/v1/models") return send(res, { models: ["chat-a", "chat-b"].map((k) => ({ key: k, loaded_instances: loaded.has(k) ? [{ id: k + "#1" }] : [] })) });
  if (withV1 && u === "/api/v1/models/load") { lastLoadBody.push(body); loaded.add(body.model); return send(res, { status: "loaded" }); }
  if (withV1 && u === "/api/v1/models/unload") { loaded.delete(String(body.instance_id).split("#")[0]); return send(res, { instance_id: body.instance_id }); }
  if (u === "/v1/chat/completions") { loaded.add(body.model); return send(res, { choices: [] }); }
  send(res, { error: "nf" }, 404);
};
const lmLoaded = new Set(["chat-a"]);
const lastLoadBody: any[] = [];
const lmOldLoaded = new Set(["chat-a"]);

// Fake Ollama
const ollamaLoaded = new Set<string>();
const ollamaHandler = (req: any, res: any, body: any) => {
  const u = req.url as string;
  if (u === "/v1/models") return send(res, { data: [{ id: "llama3:8b" }, { id: "qwen3:4b" }] });
  if (u === "/api/tags") return send(res, { models: [
    { name: "llama3:8b", size: 4_000_000_000, details: { quantization_level: "Q4_0", parameter_size: "8B" } },
    { name: "qwen3:4b", size: 2_000_000_000, details: { quantization_level: "Q4_K_M" } },
  ] });
  if (u === "/api/ps") return send(res, { models: [...ollamaLoaded].map((name) => ({ name, size: 5_000_000_000, size_vram: 4_500_000_000, expires_at: "x" })) });
  if (u === "/api/generate") { lastLoadBody.push(body); if (body.keep_alive === 0) ollamaLoaded.delete(body.model); else ollamaLoaded.add(body.model); return send(res, { done: true }); }
  send(res, { error: "nf" }, 404);
};

type Fake = Awaited<ReturnType<typeof listen>>;
let lm: Fake, lmOld: Fake, ol: Fake, generic: Fake, slow: Fake;
const prov: Record<string, string> = {};

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "omni-madmin-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
  lm = await listen(lmHandler(lmLoaded, true));
  lmOld = await listen(lmHandler(lmOldLoaded, false));
  ol = await listen(ollamaHandler);
  generic = await listen((req, res) => (req.url === "/v1/models" ? send(res, { data: [{ id: "gpt-oss-20b" }, { id: "gemma-3-12b-it" }, { id: "plain" }] }) : send(res, {}, 404)));
  slow = await listen((req, res) => {
    if (req.url === "/v1/models") send(res, { data: [{ id: "m" }] });
    else if (req.url === "/api/ps" || req.url === "/api/tags") send(res, { models: [] });
    else setTimeout(() => { try { send(res, {}, 200); } catch { /* */ } }, 3000).unref();
  });
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { windowsHide: true,
    cwd: serverDir,
    env: { ...process.env, ALLOW_REGISTRATION: "1", PORT: String(port), DB_PATH: join(tmp, "t.db"), OMNICHAT_LOCAL_PROBES: "[]", OMNICHAT_MODEL_POLL_MS: "100", OMNICHAT_MODELS_TTL_MS: "20", OMNICHAT_MODEL_ACTION_TIMEOUT_MS: "800" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((res, rej) => { child.stdout!.on("data", (d) => { if (String(d).includes("listening")) res(); }); child.once("exit", () => rej(new Error("server exited"))); });
  token = (await api("POST", "/auth/register", { username: "madmin", password: "password123" }, "")).json.token;
  for (const [k, p] of Object.entries({ lm: lm.port, lmOld: lmOld.port, ol: ol.port, generic: generic.port, slow: slow.port })) {
    prov[k] = randomUUID();
    await api("PUT", `/providers/${prov[k]}`, { name: k, kind: "openai-compatible", baseUrl: `http://127.0.0.1:${p}/v1`, model: "x" });
  }
});
after(() => {
  child?.kill();
  for (const s of servers) { s.closeAllConnections(); s.close(); }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
});
const models = async (k: string) => (await api("GET", `/providers/${prov[k]}/models?refresh=1`)).json;

test("LM Studio detection and enrichment", async () => {
  const r = await models("lm");
  assert.deepEqual(r.capabilities, { load: true, unload: true, vram: false });
  const a = r.models.find((m: any) => m.id === "chat-a");
  assert.deepEqual(a.state, { loaded: true, quantization: "Q4_K_M", contextLength: 4096, vision: false });
  assert.equal(r.models.find((m: any) => m.id === "chat-b").state.loaded, false);
  assert.equal(r.models.some((m: any) => m.id === "nomic-embed"), false);
  assert.equal((await api("GET", `/providers/${prov.lm}/models?all=1`)).json.models.some((m: any) => m.id === "nomic-embed"), true);
  const g = (await api("GET", "/models")).json.groups.find((x: any) => x.providerId === prov.lm);
  assert.equal(g.capabilities.load, true);
});

test("old LM Studio: load via JIT warm-up, unload unsupported", async () => {
  assert.deepEqual((await models("lmOld")).capabilities, { load: true, unload: false, vram: false });
  assert.equal((await api("POST", `/providers/${prov.lmOld}/models/unload`, { model: "chat-a" })).status, 501);
  const r = await api("POST", `/providers/${prov.lmOld}/models/load`, { model: "chat-b" });
  assert.equal(r.status, 200);
  assert.ok(lmOld.calls.includes("POST /v1/chat/completions"));
});

test("effort field present", async () => {
  const r = await models("generic");
  const by = (id: string) => r.models.find((m: any) => m.id === id).effort;
  assert.equal(by("gpt-oss-20b"), "supported");
  assert.equal(by("gemma-3-12b-it"), "unsupported");
  assert.equal(by("plain"), "unknown");
});

test("generic backend: no state, no capabilities, 501", async () => {
  const r = await models("generic");
  assert.equal(r.capabilities, undefined);
  assert.equal(r.models[0].state, undefined);
  for (const a of ["load", "unload"]) assert.deepEqual(await api("POST", `/providers/${prov.generic}/models/${a}`, { model: "plain" }), { status: 501, json: { error: "unsupported" } });
});

test("Ollama detection, load and unload, models_changed on state change", async () => {
  const r = await models("ol");
  assert.deepEqual(r.capabilities, { load: true, unload: true, vram: true });
  assert.deepEqual(r.models.find((m: any) => m.id === "llama3:8b").state, { loaded: false, sizeBytes: 4_000_000_000, quantization: "Q4_0" });
  const events: any[] = [];
  const ws = new WebSocket(`${wsUrl}?token=${token}`);
  ws.on("message", (d) => { try { events.push(JSON.parse(String(d))); } catch { /* */ } });
  await new Promise((res) => ws.once("open", res));
  await sleep(500);
  events.length = 0;
  // External state change (not through our API) -> the poller picks it up.
  ollamaLoaded.add("qwen3:4b");
  await sleep(1200);
  assert.ok(events.some((e) => e.type === "models_changed" && e.providerIds.includes(prov.ol)), "models_changed after external load");
  events.length = 0;
  assert.deepEqual(await api("POST", `/providers/${prov.ol}/models/load`, { model: "llama3:8b" }), { status: 200, json: { ok: true } });
  assert.ok(ol.calls.includes("POST /api/generate"));
  const st = (await api("GET", `/providers/${prov.ol}/models`)).json.models.find((m: any) => m.id === "llama3:8b").state;
  assert.equal(st.loaded, true);
  assert.equal(st.vramBytes, 4_500_000_000);
  assert.ok(events.some((e) => e.type === "models_changed"));
  assert.equal((await api("POST", `/providers/${prov.ol}/models/unload`, { model: "llama3:8b" })).status, 200);
  assert.equal(ollamaLoaded.has("llama3:8b"), false);
  ws.close();
});

test("LM Studio load/unload via v1 endpoints", async () => {
  assert.equal((await api("POST", `/providers/${prov.lm}/models/load`, { model: "chat-b" })).status, 200);
  assert.equal(lmLoaded.has("chat-b"), true);
  assert.equal((await api("POST", `/providers/${prov.lm}/models/unload`, { model: "chat-a" })).status, 200);
  assert.equal(lmLoaded.has("chat-a"), false);
  const r = await models("lm");
  assert.equal(r.models.find((m: any) => m.id === "chat-a").state.loaded, false);
  assert.equal(r.models.find((m: any) => m.id === "chat-b").state.loaded, true);
});

test("load with a context size (LM Studio reloads, Ollama num_ctx, bad value rejected)", async () => {
  lastLoadBody.length = 0;
  assert.equal((await api("POST", `/providers/${prov.lm}/models/load`, { model: "chat-b", contextLength: 16384 })).status, 200);
  assert.deepEqual(lastLoadBody.at(-1), { model: "chat-b", context_length: 16384 });
  assert.equal(lmLoaded.has("chat-b"), true);
  assert.equal((await api("POST", `/providers/${prov.ol}/models/load`, { model: "llama3:8b", contextLength: 32768 })).status, 200);
  assert.deepEqual(lastLoadBody.at(-1).options, { num_ctx: 32768 });
  assert.equal((await api("POST", `/providers/${prov.lm}/models/load`, { model: "chat-b", contextLength: 5 })).status, 400);
});

test("validation, ownership, auth, dead backend, never throws", async () => {
  assert.equal((await api("POST", `/providers/${prov.ol}/models/load`, {})).status, 400);
  assert.equal((await api("POST", `/providers/${prov.ol}/models/load`, { model: "x" }, "")).status, 401);
  assert.equal((await api("POST", `/providers/nope/models/load`, { model: "x" })).status, 404);
  const other = (await api("POST", "/auth/register", { username: "madmin2", password: "password123" }, "")).json.token;
  assert.equal((await api("POST", `/providers/${prov.ol}/models/load`, { model: "x" }, other)).status, 404);
  const dead = randomUUID();
  await api("PUT", `/providers/${dead}`, { name: "dead", kind: "openai-compatible", baseUrl: `http://127.0.0.1:${await freePort()}/v1`, model: "x" });
  assert.equal((await api("POST", `/providers/${dead}/models/load`, { model: "x" })).status, 501);
});
