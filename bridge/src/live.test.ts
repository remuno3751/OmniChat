import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { Bridge } from "./bridge.js";
import { ModelCatalog } from "./models.js";
import { fetchUpstreamModels, isAllowedUpstream, parseUpstreams, redact } from "./live.js";
import { tmpDir } from "./testutil.js";

const TOKEN = "Bearer sk-LIVE-SECRET-987";

function patch(baseURL: string, api = "openai-completions", declared = ["a", "b"]): string {
  return `- id: llm-pi-ai
  config:
    providers:
      up:
        api: ${api}
        baseURL: ${baseURL}
        headers:
          Authorization: ${TOKEN}
        models:
${declared.map((d) => `          - id: ${d}`).join("\n")}
`;
}

async function upstream(ids: string[], seen: Array<Record<string, any>> = []) {
  let status = 200;
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`,
    setIds(n: string[]) { ids = n; },
    setStatus(s: number) { status = s; },
    close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
  };
}

test("isAllowedUpstream: loopback and RFC1918 only", () => {
  for (const ok of ["http://localhost:1/v1", "http://127.0.0.1:10100/v1", "http://[::1]:1/v1", "http://10.1.2.3/v1", "http://172.16.0.1/v1", "http://172.31.255.1/v1", "http://192.168.1.5:8080/v1"]) {
    assert.equal(isAllowedUpstream(ok), true, ok);
  }
  for (const bad of ["http://example.com/v1", "https://api.openai.com/v1", "http://8.8.8.8/v1", "http://172.32.0.1/v1", "http://172.15.0.1/v1", "http://192.169.0.1/v1", "http://localhost.evil.com/v1", "http://127.0.0.1.evil.com/v1", "http://[2001:db8::1]/v1", "ftp://127.0.0.1/", "file:///etc/passwd", "http://u:p@127.0.0.1/v1", "not a url"]) {
    assert.equal(isAllowedUpstream(bad), false, bad);
  }
});

test("disallowed host is never contacted", async () => {
  let called = false;
  const r = await fetchUpstreamModels({ provider: "x", baseURL: "https://api.openai.com/v1", headers: { Authorization: TOKEN }, api: "openai" }, async () => { called = true; throw new Error("x"); });
  assert.equal(called, false);
  assert.equal(r.ids, null);
  assert.ok(!JSON.stringify(r).includes("openai.com") && !JSON.stringify(r).includes("SECRET"));
});

test("redaction strips baseURL, host, header values and bearer tokens", async () => {
  const up = { provider: "x", baseURL: "http://127.0.0.1:9/v1", headers: { Authorization: TOKEN, "X-Key": "k-secret-value" }, api: "openai" };
  const t = redact(`connect ECONNREFUSED 127.0.0.1:9 at http://127.0.0.1:9/v1/models with ${TOKEN} and k-secret-value`, up);
  for (const s of ["127.0.0.1", "SECRET", "k-secret-value", "http://"]) assert.ok(!t.includes(s), `${s} leaked: ${t}`);
  const r = await fetchUpstreamModels(up, async () => { throw new Error(`fetch failed http://127.0.0.1:9/v1/models ${TOKEN}`); });
  assert.equal(r.ids, null);
  assert.ok(!r.error!.includes("127.0.0.1") && !r.error!.includes("SECRET"));
});

test("parseUpstreams keeps baseURL/headers in memory only", () => {
  const ups = parseUpstreams(patch("http://127.0.0.1:1/v1"));
  assert.equal(ups.length, 1);
  assert.equal(ups[0].headers.Authorization, TOKEN);
});

test("catalog: live availability prunes, adds chat models, falls back, sends headers to upstream only", async () => {
  const seen: Array<Record<string, any>> = [];
  const up = await upstream(["a", "extra", "text-embedding-3", "bge-reranker", "whisper-1"], seen);
  const dir = tmpDir();
  const file = path.join(dir, "cordis.patch.yml");
  fs.writeFileSync(file, patch(up.url));
  const logs: string[] = [];
  const cat = new ModelCatalog(file, null, { onError: (m) => logs.push(m) });
  try {
    assert.deepEqual(cat.models.map((m) => m.id), ["a", "b"]);
    assert.equal(await cat.refreshLive(), true);
    assert.deepEqual(cat.models.map((m) => m.id), ["a", "extra"]); // b pruned, embed/rerank/whisper not added
    assert.deepEqual(cat.models[1], { provider: "up", id: "extra", name: "extra" });
    assert.equal(seen[0].url, "/v1/models");
    assert.equal(seen[0].auth, TOKEN);
    assert.equal(await cat.refreshLive(), false); // unchanged
    up.setIds(["a", "b"]);
    assert.equal(await cat.refreshLive(), true);
    assert.deepEqual(cat.models.map((m) => m.id), ["a", "b"]);
    up.setStatus(500);
    up.setIds([]);
    assert.equal(await cat.refreshLive(), false); // error -> declared (already shown)
    assert.deepEqual(cat.models.map((m) => m.id), ["a", "b"]);
    assert.ok(logs.length >= 1 && logs.every((l) => !l.includes("127.0.0.1") && !l.includes("SECRET")), logs.join("|"));
    up.setStatus(200);
    assert.equal(await cat.refreshLive(), true);
    assert.deepEqual(cat.models.map((m) => m.id), []); // served nothing
  } finally {
    await up.close();
  }
  // unreachable upstream -> declared
  const cat2 = new ModelCatalog(file, null);
  assert.equal(await cat2.refreshLive(), false);
  assert.deepEqual(cat2.models.map((m) => m.id), ["a", "b"]);
});

test("catalog: non-openai api kind gets pruning but no extra models", async () => {
  const up = await upstream(["a", "extra"]);
  const file = path.join(tmpDir(), "c.yml");
  fs.writeFileSync(file, patch(up.url, "anthropic-messages"));
  const cat = new ModelCatalog(file, null);
  try {
    await cat.refreshLive();
    assert.deepEqual(cat.models.map((m) => m.id), ["a"]);
  } finally {
    await up.close();
  }
});

test("bridge: models frame only when the live list changes; nothing secret on the wire", async () => {
  const up = await upstream(["a", "b"]);
  const home = tmpDir();
  const cordis = path.join(home, "profiles", "headless", "cordis.patch.yml");
  fs.mkdirSync(path.dirname(cordis), { recursive: true });
  fs.writeFileSync(cordis, patch(up.url));
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  const msgs: Array<Record<string, any>> = [];
  wss.on("connection", (ws: WebSocket) => ws.on("message", (d) => msgs.push(JSON.parse(d.toString()))));
  const logs: string[] = [];
  const bridge = new Bridge({
    serverUrl: `http://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    getToken: async () => "tok",
    name: "pc",
    cwd: home,
    dsh: { appDir: "X:\\none", profile: "headless", command: process.execPath, commandArgs: [] },
    dshHome: home,
    mirror: false,
    pollMs: 30,
    liveMs: 60,
    log: (m) => logs.push(m),
  });
  bridge.start();
  const until = async (f: () => boolean) => {
    const t = Date.now();
    while (!f()) { if (Date.now() - t > 8000) throw new Error("timeout " + JSON.stringify(msgs)); await new Promise((r) => setTimeout(r, 20)); }
  };
  try {
    await until(() => msgs.some((m) => m.type === "ready"));
    await new Promise((r) => setTimeout(r, 400)); // several live polls, list identical to declared
    assert.equal(msgs.filter((m) => m.type === "models").length, 0);
    up.setIds(["a", "zzz"]);
    await until(() => msgs.some((m) => m.type === "models"));
    const frame = msgs.find((m) => m.type === "models")!;
    assert.deepEqual(frame.models.map((m: any) => m.id), ["a", "zzz"]);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(msgs.filter((m) => m.type === "models").length, 1);
    const wire = JSON.stringify(msgs) + logs.join("\n");
    assert.ok(!wire.includes("SECRET") && !wire.includes("127.0.0.1:" + new URL(up.url).port) && !wire.includes("baseURL") && !wire.includes("Authorization"));
  } finally {
    bridge.stop();
    wss.clients.forEach((c) => c.terminate());
    await new Promise((r) => wss.close(r));
    await up.close();
  }
});
