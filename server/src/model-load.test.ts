/* eslint-disable @typescript-eslint/no-explicit-any */
// Protocol v7 model load policy (docs/PROTOCOL-v7-modelload.md): chat turns and regenerations are gated when another
// chat model is loaded next to the target on an LM Studio backend with /api/v1. Each test spawns its own server
// (setup()) and its own mock LM Studio (in this process, 127.0.0.1:0), and stops both.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { setup, connect, newConv, say, sleep, type Ctx, type Client } from "./test-chat-util.js";

// ---------- mock LM Studio ----------

const SIZES: Record<string, number> = { "chat-a": 4_000_000_000, "chat-b": 5_000_000_000, "chat-c": 6_000_000_000, "nomic-embed": 300_000_000 };
const ALL_IDS = ["chat-a", "chat-b", "chat-c", "nomic-embed"];

interface MockOpts { loaded?: string[]; loadDelayMs?: number; unloadDelayMs?: number; withV1?: boolean; jit?: boolean }
interface Mock {
  port: number;
  /** loaded model ids; tests may mutate it to simulate an external load/unload */
  loaded: Set<string>;
  /** "load X" / "unload X" / "completion X", in arrival order */
  log: string[];
  loadDelayMs: number;
  unloadDelayMs: number;
  failUnload: boolean;
  failLoad: boolean;
  /** adds the model to loaded, then answers HTTP 500 */
  failLoadButLoads: boolean;
  /** false = old LM Studio without /api/v1 */
  withV1: boolean;
  /** a completion for an unloaded model JIT-loads it (LM Studio behaviour) */
  jit: boolean;
  /** load and unload requests currently in flight, and the maxima seen */
  inFlight: number;
  maxInFlight: number;
  inFlightLoads: number;
  maxInFlightLoads: number;
  close(): void;
}

const delay = (ms: number) => (ms > 0 ? sleep(ms) : Promise.resolve());
const json = (res: any, o: unknown, code = 200) => {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(o));
};

async function startMock(o: MockOpts = {}): Promise<Mock> {
  const m: Mock = {
    port: 0,
    loaded: new Set(o.loaded ?? []),
    log: [],
    loadDelayMs: o.loadDelayMs ?? 0,
    unloadDelayMs: o.unloadDelayMs ?? 0,
    failUnload: false,
    failLoad: false,
    failLoadButLoads: false,
    withV1: o.withV1 ?? true,
    jit: o.jit ?? true,
    inFlight: 0,
    maxInFlight: 0,
    inFlightLoads: 0,
    maxInFlightLoads: 0,
    close: () => {},
  };

  const track = async <T>(kind: "load" | "unload", fn: () => Promise<T>): Promise<T> => {
    m.inFlight++;
    m.maxInFlight = Math.max(m.maxInFlight, m.inFlight);
    if (kind === "load") {
      m.inFlightLoads++;
      m.maxInFlightLoads = Math.max(m.maxInFlightLoads, m.inFlightLoads);
    }
    try {
      return await fn();
    } finally {
      m.inFlight--;
      if (kind === "load") m.inFlightLoads--;
    }
  };

  const route = async (req: any, res: any, body: any): Promise<void> => {
    const u = String(req.url);
    const get = req.method === "GET";
    const post = req.method === "POST";

    if (get && u === "/v1/models") return json(res, { data: ALL_IDS.map((id) => ({ id, object: "model" })) });

    if (get && u === "/api/v0/models") {
      return json(res, {
        data: ALL_IDS.map((id) => ({
          id,
          type: id === "nomic-embed" ? "embeddings" : "llm",
          state: m.loaded.has(id) ? "loaded" : "not-loaded",
          quantization: "Q4_K_M",
          max_context_length: 8192,
        })),
      });
    }

    if (m.withV1 && get && u === "/api/v1/models") {
      return json(res, {
        models: ALL_IDS.map((k) => ({
          key: k,
          size_bytes: SIZES[k],
          loaded_instances: m.loaded.has(k) ? [{ id: `${k}#1` }] : [],
        })),
      });
    }

    if (m.withV1 && post && u === "/api/v1/models/load") {
      const model = String(body?.model ?? "");
      m.log.push(`load ${model}`);
      return track("load", async () => {
        await delay(m.loadDelayMs);
        if (m.failLoadButLoads) {
          m.loaded.add(model);
          return json(res, { error: "load failed after loading" }, 500);
        }
        if (m.failLoad) return json(res, { error: "load failed" }, 500);
        m.loaded.add(model);
        return json(res, { status: "loaded" });
      });
    }

    if (m.withV1 && post && u === "/api/v1/models/unload") {
      const model = String(body?.instance_id ?? "").split("#")[0];
      m.log.push(`unload ${model}`);
      return track("unload", async () => {
        await delay(m.unloadDelayMs);
        if (m.failUnload) return json(res, { error: "unload failed" }, 500);
        m.loaded.delete(model);
        return json(res, { instance_id: body.instance_id });
      });
    }

    if (post && u === "/v1/chat/completions") {
      const model = String(body?.model ?? "");
      m.log.push(`completion ${model}`);
      if (m.jit) m.loaded.add(model);
      const msgs: any[] = body?.messages ?? [];
      const lastUser = [...msgs].reverse().find((x) => x.role === "user")?.content ?? "";
      res.writeHead(200, { "content-type": "text/event-stream" });
      const sse = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      for (const p of [`R:${lastUser}`, "-end"]) sse({ id: "x", choices: [{ index: 0, delta: { content: p } }] });
      sse({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      sse({ id: "x", choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } });
      res.end("data: [DONE]\n\n");
      return;
    }

    json(res, { error: "not found" }, 404);
  };

  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    let body: any = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* not json */ }
    try {
      await route(req, res, body);
    } catch (e) {
      if (!res.headersSent) json(res, { error: String(e) }, 500);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  m.port = (server.address() as AddressInfo).port;
  m.close = () => { server.closeAllConnections(); server.close(); };
  return m;
}

// ---------- harness ----------

interface H { c: Ctx; mock: Mock; pid: string; cl: Client; stop(): void }

/** A server with one openai-compatible LM Studio provider (pid) on a fresh mock, plus a connected WS client. */
async function harness(o: MockOpts = {}, env: Record<string, string> = {}): Promise<H> {
  const mock = await startMock(o);
  const c = await setup({
    OMNICHAT_MODELS_TTL_MS: "0",
    OMNICHAT_MODEL_VERIFY_MS: "1000",
    OMNICHAT_MODEL_ACTION_TIMEOUT_MS: "3000",
    ...env,
  });
  const pid = randomUUID();
  const r = await c.call("PUT", `/providers/${pid}`, {
    name: "LM", kind: "openai-compatible", baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: "chat-a",
  });
  assert.equal(r.status, 200, r.text);
  const cl = await connect(c);
  return { c, mock, pid, cl, stop() { cl.ws.close(); c.stop(); mock.close(); } };
}

async function until<T>(what: string, fn: () => T | undefined | null | false, ms = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(20);
  }
}

const conv = (h: H, model: string, extra: Record<string, unknown> = {}) =>
  newConv(h.c, { providerId: h.pid, model, ...extra });

/** Sends a user turn over the WS (ids are fresh unless given). Does not wait. */
function sendTurn(h: H, conversationId: string, extra: Record<string, unknown> = {}, ids?: { userMessageId: string; assistantMessageId: string }) {
  const userMessageId = ids?.userMessageId ?? randomUUID();
  const assistantMessageId = ids?.assistantMessageId ?? randomUUID();
  h.cl.send({ type: "send", conversationId, content: "hi there", userMessageId, assistantMessageId, ...extra });
  return { userMessageId, assistantMessageId };
}

const errFor = (h: H, messageId: string) => h.cl.frames.find((f) => f.type === "error" && f.messageId === messageId);
const modelActions = (h: H) => h.mock.log.filter((x) => /^(load|unload) /.test(x));
const completions = (h: H) => h.mock.log.filter((x) => x.startsWith("completion "));
const phases = (h: H, messageId: string) => h.cl.frames.filter((f) => f.type === "model_load" && f.messageId === messageId).map((f) => f.phase);

/** Stored messages and the conversation row as the disk store has them (GET /sync). */
async function storedIn(h: H, conversationId: string) {
  const s = (await h.c.call("GET", "/sync?since=0")).json;
  return {
    messages: s.messages.filter((m: any) => m.conversationId === conversationId),
    conv: s.conversations.find((x: any) => x.id === conversationId),
  };
}

/** A second WS view (like a reconnecting device): its ephemeral_state frame. */
async function freshEphemeralState(c: Ctx): Promise<any> {
  const cl = await connect(c);
  try {
    return await cl.waitFrame((f) => f.type === "ephemeral_state", 3000);
  } finally {
    cl.ws.close();
  }
}

// ---------- 1-5: basic policies ----------

test("1. nothing loaded: send to chat-b has no conflict and completes (LM Studio preload, then the reply)", async () => {
  const h = await harness({ loaded: [] });
  try {
    const cid = await conv(h, "chat-b");
    const { assistantMessageId } = sendTurn(h, cid);
    const asst = await h.cl.waitMsg(assistantMessageId);
    assert.equal(asst.status, "done");
    assert.equal(asst.content, "R:hi there-end");
    assert.equal(h.cl.frames.some((f) => f.type === "error"), false, "unexpected error frame");
    assert.deepEqual(h.mock.log, ["load chat-b", "completion chat-b"]);
    assert.deepEqual([...h.mock.loaded], ["chat-b"]);
  } finally {
    h.stop();
  }
});

test("2. chat-a loaded, send to chat-b without policy: model_conflict, nothing loaded or stored", async () => {
  const h = await harness({ loaded: ["chat-a"] });
  try {
    const cid = await conv(h, "chat-b");
    const { assistantMessageId } = sendTurn(h, cid);
    const err = await h.cl.waitFrame((f) => f.type === "error" && f.messageId === assistantMessageId);
    assert.equal(err.code, "model_conflict");
    assert.equal(err.conversationId, cid);
    assert.equal(err.messageId, assistantMessageId);
    assert.equal(err.conflict.providerId, h.pid);
    assert.equal(err.conflict.providerName, "LM");
    assert.equal(err.conflict.kind, "lmstudio");
    assert.equal(err.conflict.model, "chat-b");
    assert.equal(err.conflict.modelSizeBytes, SIZES["chat-b"]);
    assert.deepEqual(err.conflict.loaded.map((x: any) => x.id), ["chat-a"]);
    assert.equal(err.conflict.loaded[0].sizeBytes, SIZES["chat-a"]);
    assert.deepEqual(h.mock.log, [], "a load, unload or completion happened");
    assert.deepEqual([...h.mock.loaded], ["chat-a"]);
    assert.equal((await storedIn(h, cid)).messages.length, 0, "messages stored on conflict");
  } finally {
    h.stop();
  }
});

test("3. unload_then_load: unloads chat-a, loads chat-b, replies; phases unloading -> loading -> ready", async () => {
  const h = await harness({ loaded: ["chat-a"] });
  try {
    const cid = await conv(h, "chat-b");
    const { assistantMessageId } = sendTurn(h, cid, { loadPolicy: "unload_then_load" });
    const asst = await h.cl.waitMsg(assistantMessageId);
    assert.equal(asst.status, "done");
    assert.deepEqual(h.mock.log, ["unload chat-a", "load chat-b", "completion chat-b"]);
    assert.deepEqual(phases(h, assistantMessageId), ["unloading", "loading", "ready"]);
    const unloading = h.cl.frames.find((f) => f.type === "model_load" && f.phase === "unloading");
    assert.deepEqual(unloading.unloading, ["chat-a"]);
    assert.equal(unloading.model, "chat-b");
    assert.deepEqual([...h.mock.loaded], ["chat-b"]);
  } finally {
    h.stop();
  }
});

test("4. use_loaded: no load or unload, replies with the loaded model and switches the conversation to it", async () => {
  const h = await harness({ loaded: ["chat-a"] });
  try {
    const cid = await conv(h, "chat-b");
    const { assistantMessageId } = sendTurn(h, cid, { loadPolicy: "use_loaded" });
    const asst = await h.cl.waitMsg(assistantMessageId);
    assert.equal(asst.status, "done");
    assert.deepEqual(h.mock.log, ["completion chat-a"]);
    assert.equal(h.cl.frames.some((f) => f.type === "model_load"), false, "progress frames for use_loaded");
    assert.equal(h.cl.frames.some((f) => f.type === "upsert" && (f.conversations ?? []).some((x: any) => x.id === cid && x.model === "chat-a")), true, "no conversation upsert with chat-a");
    assert.equal((await storedIn(h, cid)).conv.model, "chat-a");
    assert.deepEqual([...h.mock.loaded], ["chat-a"]);
  } finally {
    h.stop();
  }
});

test("5. load_both: loads chat-b next to chat-a, nothing unloaded", async () => {
  const h = await harness({ loaded: ["chat-a"] });
  try {
    const cid = await conv(h, "chat-b");
    const { assistantMessageId } = sendTurn(h, cid, { loadPolicy: "load_both" });
    const asst = await h.cl.waitMsg(assistantMessageId);
    assert.equal(asst.status, "done");
    assert.deepEqual(h.mock.log, ["load chat-b", "completion chat-b"]);
    assert.deepEqual(phases(h, assistantMessageId), ["loading", "ready"]);
    assert.deepEqual([...h.mock.loaded].sort(), ["chat-a", "chat-b"]);
  } finally {
    h.stop();
  }
});

// ---------- 6: several loaded ----------

test("6a. several loaded (chat-a, chat-c), target chat-b: conflict lists both sorted; unload_then_load unloads both", async () => {
  const h = await harness({ loaded: ["chat-c", "chat-a"] });
  try {
    const cid = await conv(h, "chat-b");
    const first = sendTurn(h, cid);
    const err = await h.cl.waitFrame((f) => f.type === "error" && f.messageId === first.assistantMessageId);
    assert.equal(err.code, "model_conflict");
    assert.deepEqual(err.conflict.loaded.map((x: any) => x.id), ["chat-a", "chat-c"]);
    assert.deepEqual(h.mock.log, []);

    const second = sendTurn(h, cid, { loadPolicy: "unload_then_load" });
    const asst = await h.cl.waitMsg(second.assistantMessageId);
    assert.equal(asst.status, "done");
    assert.deepEqual(h.mock.log, ["unload chat-a", "unload chat-c", "load chat-b", "completion chat-b"]);
    assert.deepEqual([...h.mock.loaded], ["chat-b"]);
  } finally {
    h.stop();
  }
});

test("6b. several loaded (chat-a, chat-c), target chat-b: use_loaded with useModel chat-c switches to chat-c", async () => {
  const h = await harness({ loaded: ["chat-a", "chat-c"] });
  try {
    const cid = await conv(h, "chat-b");
    const { assistantMessageId } = sendTurn(h, cid, { loadPolicy: "use_loaded", useModel: "chat-c" });
    const asst = await h.cl.waitMsg(assistantMessageId);
    assert.equal(asst.status, "done");
    assert.deepEqual(h.mock.log, ["completion chat-c"]);
    assert.equal((await storedIn(h, cid)).conv.model, "chat-c");
  } finally {
    h.stop();
  }
});

// ---------- 7-9: failures and invalid policy ----------

test("7. unload failure: model_load_failed with conflict, nothing stored, chat-a still loaded; retry with the same ids succeeds", async () => {
  const h = await harness({ loaded: ["chat-a"] });
  try {
    h.mock.failUnload = true;
    const cid = await conv(h, "chat-b");
    const ids = { userMessageId: randomUUID(), assistantMessageId: randomUUID() };
    sendTurn(h, cid, { loadPolicy: "unload_then_load" }, ids);
    const err = await h.cl.waitFrame((f) => f.type === "error" && f.messageId === ids.assistantMessageId);
    assert.equal(err.code, "model_load_failed");
    assert.equal(err.conversationId, cid);
    assert.equal(typeof err.message, "string");
    assert.ok(err.message.length > 0);
    assert.deepEqual(err.conflict.loaded.map((x: any) => x.id), ["chat-a"]);
    assert.deepEqual(h.mock.log, ["unload chat-a"], "a load was attempted after the failed unload");
    assert.deepEqual([...h.mock.loaded], ["chat-a"]);
    assert.equal((await storedIn(h, cid)).messages.length, 0, "messages stored after model_load_failed");

    // the client re-sends the same request once the backend works again
    h.mock.failUnload = false;
    sendTurn(h, cid, { loadPolicy: "unload_then_load" }, ids);
    const asst = await h.cl.waitMsg(ids.assistantMessageId);
    assert.equal(asst.status, "done");
    assert.deepEqual(h.mock.log, ["unload chat-a", "unload chat-a", "load chat-b", "completion chat-b"]);
    assert.deepEqual([...h.mock.loaded], ["chat-b"]);
  } finally {
    h.stop();
  }
});

test("8a. load failure: model_load_failed, nothing stored, no completion", async () => {
  const h = await harness({ loaded: ["chat-a"] });
  try {
    h.mock.failLoad = true;
    const cid = await conv(h, "chat-b");
    const { assistantMessageId } = sendTurn(h, cid, { loadPolicy: "unload_then_load" });
    const err = await h.cl.waitFrame((f) => f.type === "error" && f.messageId === assistantMessageId);
    assert.equal(err.code, "model_load_failed");
    assert.match(err.message, /chat-b/);
    assert.deepEqual(err.conflict.loaded.map((x: any) => x.id), ["chat-a"]);
    assert.deepEqual(h.mock.log, ["unload chat-a", "load chat-b"]);
    assert.deepEqual(completions(h), []);
    assert.equal((await storedIn(h, cid)).messages.length, 0, "messages stored after model_load_failed");
  } finally {
    h.stop();
  }
});

test("8b. load that reports failure but leaves the model loaded counts as success", async () => {
  const h = await harness({ loaded: ["chat-a"] });
  try {
    h.mock.failLoadButLoads = true;
    const cid = await conv(h, "chat-b");
    const { assistantMessageId } = sendTurn(h, cid, { loadPolicy: "unload_then_load" });
    const asst = await h.cl.waitMsg(assistantMessageId);
    assert.equal(asst.status, "done");
    assert.equal(h.cl.frames.some((f) => f.type === "error"), false, "error frame despite the target being loaded");
    assert.deepEqual(phases(h, assistantMessageId), ["unloading", "loading", "ready"]);
    assert.deepEqual(h.mock.log, ["unload chat-a", "load chat-b", "completion chat-b"]);
    assert.deepEqual([...h.mock.loaded], ["chat-b"]);
  } finally {
    h.stop();
  }
});

test("9. invalid loadPolicy is ignored: model_conflict, nothing happens", async () => {
  const h = await harness({ loaded: ["chat-a"] });
  try {
    const cid = await conv(h, "chat-b");
    const { assistantMessageId } = sendTurn(h, cid, { loadPolicy: "bogus" });
    const err = await h.cl.waitFrame((f) => f.type === "error" && f.messageId === assistantMessageId);
    assert.equal(err.code, "model_conflict");
    assert.deepEqual(h.mock.log, []);
    assert.deepEqual([...h.mock.loaded], ["chat-a"]);
    assert.equal((await storedIn(h, cid)).messages.length, 0);
  } finally {
    h.stop();
  }
});

// ---------- 10: code mode is never gated ----------

test("10. code-mode conversation: never gated by the model conflict; a non-bridge provider is refused (code_not_bridge), nothing loads", async () => {
  const h = await harness({ loaded: ["chat-a"] });
  try {
    const cid = await conv(h, "chat-b", { mode: "code" });
    const { assistantMessageId } = sendTurn(h, cid);
    const err = await h.cl.waitFrame((f) => f.type === "error" && f.messageId === assistantMessageId);
    assert.equal(err.code, "code_not_bridge");
    assert.equal(h.cl.frames.some((f) => f.type === "error" && f.code === "model_conflict"), false);
    assert.deepEqual(h.mock.log, []);
    assert.deepEqual([...h.mock.loaded], ["chat-a"]);
    assert.equal((await storedIn(h, cid)).messages.length, 0);
  } finally {
    h.stop();
  }
});

// ---------- 11: backends without control ----------

test("11a. old LM Studio without /api/v1: no conflict, no dialog, nothing changes", async () => {
  const h = await harness({ loaded: ["chat-a"], withV1: false });
  try {
    const cid = await conv(h, "chat-b");
    const { assistantMessageId } = sendTurn(h, cid);
    const asst = await h.cl.waitMsg(assistantMessageId);
    assert.equal(asst.status, "done");
    assert.equal(h.cl.frames.some((f) => f.type === "error"), false);
    assert.deepEqual(h.mock.log, ["completion chat-b"]);

    const st = await h.c.call("GET", `/providers/${h.pid}/models/loaded?model=chat-b`);
    assert.equal(st.json.controllable, false);
    assert.deepEqual(st.json.loaded, []);
    assert.equal(st.json.conflict, null);
  } finally {
    h.stop();
  }
});

test("11b. plain backend (404 on every probe): no conflict, no dialog, the reply goes through", async () => {
  const h = await harness({ loaded: ["chat-a"] });
  try {
    const cid = await newConv(h.c, { providerId: h.c.provId, model: "fake-model" });
    const before = h.c.be.bodies.length;
    const asst = await say(h.c, h.cl, cid, "plain");
    assert.equal(asst.asst.status, "done");
    assert.equal(h.cl.frames.some((f) => f.type === "error"), false);
    assert.equal(h.c.be.bodies.length - before, 1, "exactly one backend completion");

    const st = await h.c.call("GET", `/providers/${h.c.provId}/models/loaded?model=fake-model`);
    assert.equal(st.json.controllable, false);
    assert.equal(st.json.conflict, null);
  } finally {
    h.stop();
  }
});

// ---------- 12: what counts as loaded ----------

test("12a. embedding model loaded alone does not count: no conflict", async () => {
  const h = await harness({ loaded: ["nomic-embed"] });
  try {
    const cid = await conv(h, "chat-b");
    const { assistantMessageId } = sendTurn(h, cid);
    const asst = await h.cl.waitMsg(assistantMessageId);
    assert.equal(asst.status, "done");
    assert.equal(h.cl.frames.some((f) => f.type === "error"), false, "embedding model caused a conflict");
    assert.equal(modelActions(h).some((x) => x.startsWith("unload")), false);
    assert.deepEqual(h.mock.log, ["load chat-b", "completion chat-b"]);
    assert.deepEqual([...h.mock.loaded].sort(), ["chat-b", "nomic-embed"]);
  } finally {
    h.stop();
  }
});

test("12b. target already loaded while another chat model is also loaded: no conflict, no load", async () => {
  const h = await harness({ loaded: ["chat-a", "chat-b"] });
  try {
    const cid = await conv(h, "chat-b");
    const { assistantMessageId } = sendTurn(h, cid);
    const asst = await h.cl.waitMsg(assistantMessageId);
    assert.equal(asst.status, "done");
    assert.equal(h.cl.frames.some((f) => f.type === "error"), false);
    assert.deepEqual(h.mock.log, ["completion chat-b"]);
  } finally {
    h.stop();
  }
});

// ---------- 13: serialization ----------

test("13a. two chats at once to different models, nothing loaded: one loads, the other gets model_conflict", async () => {
  const h = await harness({ loaded: [], loadDelayMs: 300 });
  try {
    const c1 = await conv(h, "chat-b");
    const c2 = await conv(h, "chat-c");
    const s1 = sendTurn(h, c1);
    const s2 = sendTurn(h, c2);
    await until("both turns settled", () =>
      [s1, s2].every((s) => errFor(h, s.assistantMessageId) || h.cl.msg(s.assistantMessageId)?.status === "done"));

    const errs = h.cl.frames.filter((f) => f.type === "error" && [s1.assistantMessageId, s2.assistantMessageId].includes(f.messageId));
    assert.equal(errs.length, 1, `expected exactly one conflict, got ${errs.length}`);
    assert.equal(errs[0].code, "model_conflict");
    // the loser is the chat that was refused; the winner is the other model
    const winner = errs[0].messageId === s1.assistantMessageId ? "chat-c" : "chat-b";
    assert.deepEqual(errs[0].conflict.loaded.map((x: any) => x.id), [winner]);
    assert.deepEqual(modelActions(h), [`load ${winner}`]);
    assert.equal(h.mock.maxInFlightLoads, 1);
    assert.deepEqual([...h.mock.loaded], [winner]);
  } finally {
    h.stop();
  }
});

test("13b. two concurrent unload_then_load sends never overlap their load/unload calls and end with one model", async () => {
  // jit off: a completion of the first chat must not re-load its model after the second chat unloaded it
  const h = await harness({ loaded: ["chat-a"], loadDelayMs: 300, unloadDelayMs: 150, jit: false });
  try {
    const c1 = await conv(h, "chat-b");
    const c2 = await conv(h, "chat-c");
    const s1 = sendTurn(h, c1, { loadPolicy: "unload_then_load" });
    const s2 = sendTurn(h, c2, { loadPolicy: "unload_then_load" });
    await until("both turns done", () =>
      [s1, s2].every((s) => h.cl.msg(s.assistantMessageId)?.status === "done"), 8000);

    assert.ok(h.mock.maxInFlight <= 1, `load/unload overlapped: max in flight ${h.mock.maxInFlight}`);
    assert.ok(h.mock.maxInFlightLoads <= 1);
    const acts = modelActions(h);
    assert.equal(acts.length, 4, `unexpected actions: ${acts.join(", ")}`);
    const last = acts.at(-1)!;
    assert.match(last, /^load /, "the last action must be a load");
    assert.deepEqual([...h.mock.loaded], [last.slice("load ".length)]);
    assert.ok(h.mock.log.includes("completion chat-b") && h.mock.log.includes("completion chat-c"));
  } finally {
    h.stop();
  }
});

// ---------- 14: regenerate ----------

test("14. regenerate is gated: conflict created outside, regenerate in a chat-b conversation -> model_conflict", async () => {
  const h = await harness({ loaded: [] });
  try {
    const cid = await conv(h, "chat-b");
    const first = sendTurn(h, cid);
    await h.cl.waitMsg(first.assistantMessageId);

    // someone else swaps the models: chat-b unloaded, chat-a loaded
    h.mock.loaded.delete("chat-b");
    h.mock.loaded.add("chat-a");
    h.mock.log.length = 0;

    const rid = randomUUID();
    h.cl.send({ type: "regenerate", conversationId: cid, messageId: first.assistantMessageId, assistantMessageId: rid });
    const err = await h.cl.waitFrame((f) => f.type === "error" && f.messageId === rid);
    assert.equal(err.code, "model_conflict");
    assert.equal(err.conflict.model, "chat-b");
    assert.deepEqual(err.conflict.loaded.map((x: any) => x.id), ["chat-a"]);
    assert.deepEqual(h.mock.log, []);
    assert.equal((await storedIn(h, cid)).messages.some((m: any) => m.id === rid), false, "regenerated message stored");
  } finally {
    h.stop();
  }
});

// ---------- 15: REST state ----------

test("15. GET /providers/:id/models/loaded reports the conflict; the plain backend is not controllable", async () => {
  const h = await harness({ loaded: ["chat-a"] });
  try {
    const r = await h.c.call("GET", `/providers/${h.pid}/models/loaded?model=chat-b`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.controllable, true);
    assert.equal(r.json.kind, "lmstudio");
    assert.deepEqual(r.json.loaded.map((x: any) => x.id), ["chat-a"]);
    assert.equal(r.json.loaded[0].sizeBytes, SIZES["chat-a"]);
    assert.equal(r.json.targetLoaded, false);
    assert.equal(r.json.conflict.model, "chat-b");
    assert.equal(r.json.conflict.providerId, h.pid);
    assert.deepEqual(r.json.conflict.loaded.map((x: any) => x.id), ["chat-a"]);

    const same = await h.c.call("GET", `/providers/${h.pid}/models/loaded?model=chat-a`);
    assert.equal(same.json.targetLoaded, true);
    assert.equal(same.json.conflict, null);

    const plain = await h.c.call("GET", `/providers/${h.c.provId}/models/loaded?model=fake-model`);
    assert.equal(plain.status, 200);
    assert.equal(plain.json.controllable, false);
    assert.deepEqual(plain.json.loaded, []);
    assert.equal(plain.json.targetLoaded, null);
    assert.equal(plain.json.conflict, null);
  } finally {
    h.stop();
  }
});

// ---------- 16: ephemeral chats ----------

test("16. ephemeral chat is gated like a chat: model_conflict, nothing stored", async () => {
  const h = await harness({ loaded: ["chat-a"] });
  try {
    const eid = `eph_${randomUUID()}`;
    const put = await h.c.call("PUT", `/conversations/${eid}`, { ephemeral: true, providerId: h.pid, model: "chat-b" });
    assert.equal(put.status, 200, put.text);
    const ids = { userMessageId: `eph_${randomUUID()}`, assistantMessageId: `eph_${randomUUID()}` };
    sendTurn(h, eid, {}, ids);
    const err = await h.cl.waitFrame((f) => f.type === "error" && f.messageId === ids.assistantMessageId);
    assert.equal(err.code, "model_conflict");
    assert.equal(err.conflict.model, "chat-b");
    assert.deepEqual(h.mock.log, []);
    const st = await freshEphemeralState(h.c);
    assert.equal(st.messages.some((m: any) => m.conversationId === eid), false, "ephemeral message stored");
  } finally {
    h.stop();
  }
});
