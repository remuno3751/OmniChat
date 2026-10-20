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
import { filterChat, isChatModelId } from "./models.js";
import { normalizeBaseUrl } from "./local-servers.js";

const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");
let child: ChildProcess;
let port = 0;
let tmp = "";
let base = "";
let token = "";
const servers: Server[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 6000) => {
  const t = Date.now();
  while (!f()) { if (Date.now() - t > ms) throw new Error("timeout"); await sleep(20); }
};
function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createNet().listen(0, () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
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

/** Fake OpenAI-compatible server with mutable model list/status. */
async function fake(ids: string[]) {
  let status = 200;
  const srv = createHttp((_req, res) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  servers.push(srv);
  return { port: (srv.address() as AddressInfo).port, setIds(n: string[]) { ids = n; }, setStatus(s: number) { status = s; } };
}

let lmStudio: Awaited<ReturnType<typeof fake>>;
let broken: Awaited<ReturnType<typeof fake>>;
let deadPort = 0;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "omni-models-"));
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  lmStudio = await fake(["chat-a", "chat-b", "text-embedding-nomic", "bge-reranker-v2", "whisper-1", "tts-1", "omni-moderation-latest"]);
  broken = await fake(["x"]);
  broken.setStatus(500);
  deadPort = await freePort();
  const probes = [
    { name: "LM Studio", baseUrl: `http://127.0.0.1:${lmStudio.port}/v1` },
    { name: "Broken", baseUrl: `http://127.0.0.1:${broken.port}/v1` },
    { name: "Dead", baseUrl: `http://127.0.0.1:${deadPort}/v1` },
  ];
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { windowsHide: true,
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: join(tmp, "t.db"),
      OMNICHAT_LOCAL_PROBES: JSON.stringify(probes),
      OMNICHAT_MODEL_POLL_MS: "150",
      OMNICHAT_MODELS_TTL_MS: "50",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((res, rej) => {
    child.stdout!.on("data", (d) => { if (String(d).includes("listening")) res(); });
    child.once("exit", () => rej(new Error("server exited")));
  });
  const r = await api("POST", "/auth/register", { username: "modeltester", password: "password123" }, "");
  token = r.json.token;
});
after(() => {
  child?.kill();
  for (const s of servers) { s.closeAllConnections(); s.close(); }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("filter helpers", () => {
  for (const id of ["text-embedding-3", "nomic-embed-text", "bge-reranker", "whisper-1", "tts-1", "omni-moderation-latest", "EMBED-X"]) assert.equal(isChatModelId(id), false, id);
  for (const id of ["llama3", "qwen2.5-coder", "lm-studio/lfm2.5-24b"]) assert.equal(isChatModelId(id), true, id);
  assert.deepEqual(filterChat([{ id: "a" }, { id: "embed" }], false), [{ id: "a" }]);
  assert.equal(filterChat([{ id: "a" }, { id: "embed" }], true).length, 2);
  assert.equal(normalizeBaseUrl("http://127.0.0.1:1234/v1/"), normalizeBaseUrl("HTTP://localhost:1234/v1"));
  assert.notEqual(normalizeBaseUrl("http://localhost:1234/v1"), normalizeBaseUrl("http://localhost:1235/v1"));
});

test("models: non-chat filtered, ?all=1 keeps them, fetchedAt, errors uncached", async () => {
  const p = randomUUID();
  await api("PUT", `/providers/${p}`, { name: "LM", kind: "openai-compatible", baseUrl: `http://127.0.0.1:${lmStudio.port}/v1`, model: "x" });
  const t0 = Date.now();
  const r1 = (await api("GET", `/providers/${p}/models`)).json;
  assert.deepEqual(r1.models.map((m: any) => m.id), ["chat-a", "chat-b"]);
  assert.ok(r1.fetchedAt >= t0 - 5 && r1.fetchedAt <= Date.now());
  const all = (await api("GET", `/providers/${p}/models?all=1`)).json;
  assert.equal(all.models.length, 7);
  const g = (await api("GET", "/models")).json.groups.find((x: any) => x.providerId === p);
  assert.deepEqual(g.models.map((m: any) => m.id), ["chat-a", "chat-b"]);
  assert.equal(typeof g.fetchedAt, "number");
  assert.equal((await api("GET", "/models?all=1")).json.groups.find((x: any) => x.providerId === p).models.length, 7);

  lmStudio.setStatus(500);
  await sleep(80); // past the (test) TTL
  const bad = (await api("GET", `/providers/${p}/models`)).json;
  assert.match(bad.error, /HTTP 500/);
  lmStudio.setStatus(200); // error was not cached: immediately healthy again
  const ok = (await api("GET", `/providers/${p}/models`)).json;
  assert.equal(ok.error, undefined);
  assert.equal(ok.models.length, 2);
  await api("DELETE", `/providers/${p}`);
});

test("models_changed is broadcast to /ws when a provider's list changes", async () => {
  const up = await fake(["m1"]);
  const p = randomUUID();
  await api("PUT", `/providers/${p}`, { name: "Up", kind: "openai-compatible", baseUrl: `http://127.0.0.1:${up.port}/v1`, model: "x" });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  const frames: any[] = [];
  ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
  await until(() => frames.some((f) => f.type === "hello"));
  await sleep(500); // baseline established by polling, several rounds with no change
  assert.equal(frames.filter((f) => f.type === "models_changed").length, 0);
  up.setIds(["m1", "m2"]);
  await until(() => frames.some((f) => f.type === "models_changed"));
  assert.deepEqual(frames.find((f) => f.type === "models_changed").providerIds, [p]);
  await sleep(500);
  assert.equal(frames.filter((f) => f.type === "models_changed").length, 1); // not repeated
  up.setIds(["m1", "m2", "text-embedding-x"]); // non-chat change is invisible
  await sleep(500);
  assert.equal(frames.filter((f) => f.type === "models_changed").length, 1);
  up.setStatus(500); // errors do not count as change
  await sleep(400);
  assert.equal(frames.filter((f) => f.type === "models_changed").length, 1);
  ws.close();
  await api("DELETE", `/providers/${p}`);
});

test("/local-servers: only answering servers, chat model count, skips configured, auth", async () => {
  assert.equal((await api("GET", "/local-servers", undefined, "bad")).status, 401);
  const r = (await api("GET", "/local-servers")).json;
  assert.equal(r.servers.length, 1);
  const { modelIds, ...rest } = r.servers[0];
  assert.deepEqual(rest, { name: "LM Studio", kind: "openai-compatible", baseUrl: `http://127.0.0.1:${lmStudio.port}/v1`, models: 2 });
  assert.equal(modelIds.length, 2); // chat model ids, so the client can pick one
  // already configured (localhost vs 127.0.0.1, trailing slash) -> skipped
  const p = randomUUID();
  await api("PUT", `/providers/${p}`, { name: "Mine", kind: "openai-compatible", baseUrl: `http://localhost:${lmStudio.port}/v1/`, model: "x" });
  assert.deepEqual((await api("GET", "/local-servers")).json.servers, []);
  // deleted provider no longer hides it
  await api("DELETE", `/providers/${p}`);
  assert.equal((await api("GET", "/local-servers")).json.servers.length, 1);
});
