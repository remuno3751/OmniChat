import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectAdapter, getJson, postJson } from "./adapters/index.js";
import { backendLimit } from "./context.js";

/* Runtimes that require a Bearer key (Strata, llama-swap / Bonsai). Responses are the recorded shapes in __fixtures__/runtimes.json. */

const fx = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "runtimes.json"), "utf8"));
const KEY = "test-key";
const STRATA_MODEL = "qwen3.8-flash-next-iq3_xxs";
const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

type Route = { status: number; body?: unknown };

/** Fake runtime: every path except /health answers 401 (empty body) without `Authorization: Bearer test-key`; unknown paths are 404. */
async function fake(routes: Record<string, Route>): Promise<string> {
  const srv = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/health" && req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401); res.end(); return; }
    const r = routes[path];
    if (!r) { res.writeHead(404); res.end(); return; }
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(r.body === undefined ? "" : JSON.stringify(r.body));
  });
  servers.push(srv);
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", () => ok()));
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

const strataRoutes = (): Record<string, Route> => ({
  "/health": { status: 200, body: fx.strata.health },
  "/v1/models": { status: 200, body: fx.strata.models },
  "/props": { status: 200, body: fx.strata.props },
});

const bonsaiRoutes = (): Record<string, Route> => ({
  "/health": { status: 200 },
  "/v1/models": { status: 200, body: fx.bonsai.models },
  // llama-swap: /props is not served for unloaded models; the other llama.cpp / Ollama / LM Studio endpoints do not exist.
  "/props": { status: 404 },
  "/api/ps": { status: 404 },
  "/api/tags": { status: 404 },
  "/api/v0/models": { status: 404 },
  "/api/v1/models": { status: 404 },
});

test("Strata-like runtime: the context limit is read only with the Bearer key", async () => {
  const base = await fake(strataRoutes());
  const prov = { kind: "openai-compatible", base_url: `${base}/v1`, api_key: KEY };
  assert.equal(await backendLimit(prov, STRATA_MODEL), 65536);
  assert.equal(await backendLimit({ ...prov, api_key: "" }, STRATA_MODEL), null);
  assert.equal((await detectAdapter(base, false, KEY)).adapter?.kind, "llamacpp");
  assert.equal((await detectAdapter(base)).adapter, null);
});

test("llama-swap (Bonsai) runtime: limits come from /v1/models, models without a window are null", async () => {
  const base = await fake(bonsaiRoutes());
  const prov = { kind: "openai-compatible", base_url: base, api_key: KEY };
  assert.equal(await backendLimit(prov, "bonsai2"), 65536);
  assert.equal(await backendLimit(prov, "bonsai2-4b"), 131072);
  assert.equal(await backendLimit(prov, "bonsai2-4b-long"), null);
  assert.equal(await backendLimit(prov, "no-such-model"), null);
  const det = await detectAdapter(base, false, KEY);
  assert.equal(det.adapter?.kind, "generic");
  assert.deepEqual(det.capabilities, { load: false, unload: false, vram: false });
  assert.equal((await detectAdapter(base)).adapter, null);
  assert.equal(await backendLimit({ ...prov, api_key: "" }, "bonsai2"), null);
});

test("generic adapter does not match a model list without context windows", async () => {
  const base = await fake({ "/v1/models": { status: 200, body: { object: "list", data: [{ id: "gpt-x", object: "model" }] } } });
  assert.equal((await detectAdapter(base, false, KEY)).adapter, null);
});

test("the API key never appears in errors or logs", async () => {
  const base = await fake(strataRoutes());
  const seen: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const orig = methods.map((m) => console[m]);
  for (const m of methods) (console as any)[m] = (...a: unknown[]) => { seen.push(a.map(String).join(" ")); };
  try {
    const det = await detectAdapter(base, false, KEY);
    assert.equal(det.adapter?.kind, "llamacpp");
    const errs: string[] = [];
    await getJson(`${base}/nope`, 1000, KEY).catch((e) => errs.push(String(e?.message ?? e)));
    await postJson(`${base}/nope`, {}, 1000, KEY).catch((e) => errs.push(String(e?.message ?? e)));
    await getJson("http://127.0.0.1:1/x", 500, KEY).catch((e) => errs.push(String(e?.message ?? e)));
    await detectAdapter(base, true, "wrong-key");
    await backendLimit({ kind: "openai-compatible", base_url: base, api_key: KEY }, STRATA_MODEL);
    assert.ok(errs.length === 3);
    for (const t of [...errs, ...seen]) assert.ok(!t.includes(KEY), `key leaked: ${t}`);
  } finally {
    methods.forEach((m, i) => { (console as any)[m] = orig[i]; });
  }
});
