// Web search (PROTOCOL-v6.md 1.1b): built-in engines, API engines, SearXNG and the fallback router.
// A fake upstream on 127.0.0.1 stands in for Bing RSS, Wikipedia, DuckDuckGo, Brave, Tavily and SearXNG. Each engine is
// pointed at it with OMNICHAT_SEARCH_BASE_<ENGINE> (path-prefixed: /bing, /wiki, /ddg, /brave, /tavily, /searxng), so the
// fake routes by the first path segment. Engine health and the result cache live in each server process, so every
// describe() below starts its own server(s).
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startServer, api, type TestServer } from "./test-server.js";

/** What the fake upstream does for one engine (segment). */
type Mode = "ok" | "429" | "captcha" | "empty" | "500" | "big" | "bigchunked" | "delay" | "redirect";
interface Call { engine: string; url: URL; headers: IncomingMessage["headers"]; body: string }

const KEY_BRAVE = "BRAVE-FAKE-KEY-123456";
const KEY_TAVILY = "TAVILY-FAKE-KEY-654321";

// ---------------------------------------------------------------- fake upstream

const modes: Record<string, Mode> = {};
const log: Call[] = [];
let PORT = 0;
let FAKE = "";

const setModes = (m: Record<string, Mode>) => {
  for (const k of Object.keys(modes)) delete modes[k];
  Object.assign(modes, m);
};
const calls = (engine: string): Call[] => log.filter((c) => c.engine === engine);
const lastCall = (engine: string): Call => {
  const c = calls(engine).at(-1);
  assert.ok(c, `no request reached ${engine}`);
  return c;
};

const BING_RSS = `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Bing</title>
<item><title>Bing one</title><link>https://www.example.com/page-a?utm_source=newsletter</link><description>First &amp; best</description></item>
<item><title>Bing two</title><link>https://bing.example.org/two/</link><description>Second</description></item>
<item><title>Bing three</title><link>https://bing.example.net/three</link><description>Third</description></item>
</channel></rss>`;
const WIKI = JSON.stringify({ query: { search: [
  { title: "Wiki one", snippet: "<span>wiki</span> one" },
  { title: "Wiki two", snippet: "two" },
  { title: "Wiki three", snippet: "three" },
] } });
// result 1 is the same page as bing's result 1 (other host spelling, trailing slash, no utm)
const DDG = `<html><body>
<div class="result"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage-a%2F&amp;rut=1">DDG one</a></h2><a class="result__snippet" href="#">ddg snippet one</a></div>
<div class="result"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fddg.example.io%2Ftwo&amp;rut=2">DDG two</a></h2><a class="result__snippet" href="#">ddg snippet two</a></div>
<div class="result"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fddg.example.io%2Fthree&amp;rut=3">DDG three</a></h2><a class="result__snippet" href="#">ddg snippet three</a></div>
</body></html>`;
const BRAVE = JSON.stringify({ web: { results: [
  { title: "Brave one", url: "https://brave.example.dev/one", description: "b one" },
  { title: "Brave two", url: "https://brave.example.dev/two", description: "b two" },
] } });
const TAVILY = JSON.stringify({ results: [
  { title: "Tavily one", url: "https://tavily.example.app/one", content: "t one" },
  { title: "Tavily two", url: "https://tavily.example.app/two", content: "t two" },
] });
const SEARXNG = JSON.stringify({ results: [
  { title: "SearXNG one", url: "https://sx.example.dev/one", content: "sx one" },
], unresponsive_engines: [] });

const OK: Record<string, [string, string]> = {
  bing: ["text/xml", BING_RSS],
  wiki: ["application/json", WIKI],
  ddg: ["text/html", DDG],
  brave: ["application/json", BRAVE],
  tavily: ["application/json", TAVILY],
  searxng: ["application/json", SEARXNG],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const engine = url.pathname.split("/")[1] ?? "";
  log.push({ engine, url, headers: req.headers, body });
  const mode: Mode = modes[engine] ?? "ok";
  const send = (status: number, type: string, text: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": type, ...extra });
    res.end(text);
  };

  if (engine === "target") return send(200, "text/plain", "target reached");
  if (mode === "delay") await sleep(2500);
  if (mode === "429") return send(429, "text/plain", "Too many requests");
  if (mode === "500") return send(500, "text/plain", "upstream broke");
  if (mode === "redirect") return send(302, "text/plain", "", { location: `http://localhost:${PORT}/target/x` });
  if (mode === "captcha") return send(200, "text/html", "<html><body>Unusual traffic from your network. Please complete the CAPTCHA.</body></html>");
  if (mode === "empty") return send(200, "text/plain", "");
  if (mode === "big") {
    const n = Math.floor(1.1 * 1024 * 1024);
    return send(200, "text/xml", "a".repeat(n), { "content-length": String(n) });
  }
  if (mode === "bigchunked") {
    // no content-length: the 1 MB cap has to be enforced while streaming
    res.writeHead(200, { "content-type": "text/xml" });
    for (let i = 0; i < 18; i++) res.write("a".repeat(64 * 1024));
    res.end();
    return;
  }
  const hit = OK[engine];
  if (!hit) return send(404, "text/plain", "not found");
  return send(200, hit[0], hit[1]);
}

const fakeServer: Server = createServer((req, res) => {
  handle(req, res).catch(() => { try { res.destroy(); } catch { /* already gone */ } });
});
await new Promise<void>((r) => fakeServer.listen(0, "127.0.0.1", () => r()));
PORT = (fakeServer.address() as AddressInfo).port;
FAKE = `http://127.0.0.1:${PORT}`;
after(() => { fakeServer.closeAllConnections(); fakeServer.close(); });

// ---------------------------------------------------------------- server env and helpers

/** Env shared by every server here: no inherited SearXNG/API defaults from test.env, fast timeouts, no cache. */
const BASE: Record<string, string> = {
  SEARCH_BACKEND: "",
  SEARCH_FALLBACK: "",
  SEARXNG_URL: "",
  SEARCH_ENGINES: "",
  BRAVE_API_KEY: "",
  TAVILY_API_KEY: "",
  SEARCH_MAX_RESULTS: "5",
  SEARCH_ENGINE_TIMEOUT_MS: "1500",
  OMNICHAT_SEARCH_CACHE_TTL_MS: "0",
  OMNICHAT_SEARCH_STATUS_TTL_MS: "0",
  OMNICHAT_SEARCH_COOLDOWN_MS: "600000",
  ALLOW_REGISTRATION: "1",
  OMNICHAT_OPEN_FIRST_REGISTRATION: "1",
  OMNICHAT_SEARCH_BASE_BING_RSS: `${FAKE}/bing`,
  OMNICHAT_SEARCH_BASE_WIKIPEDIA: `${FAKE}/wiki`,
  OMNICHAT_SEARCH_BASE_DUCKDUCKGO: `${FAKE}/ddg`,
  OMNICHAT_SEARCH_BASE_BRAVE: `${FAKE}/brave`,
  OMNICHAT_SEARCH_BASE_TAVILY: `${FAKE}/tavily`,
};

beforeEach(() => setModes({}));

/** The first registered account is the admin; the second is a normal user. */
async function accounts(s: TestServer): Promise<{ admin: string; user: string }> {
  const a = await api(s.base, "POST", "/auth/register", { username: "admin1", password: "password123" });
  const u = await api(s.base, "POST", "/auth/register", { username: "normal1", password: "password123" });
  assert.equal(a.status, 200, a.text);
  assert.equal(u.status, 200, u.text);
  return { admin: a.json.token, user: u.json.token };
}

const post = (s: TestServer, tok: string, body: unknown) => api(s.base, "POST", "/search/test", body, tok);
const putCfg = (s: TestServer, tok: string, body: unknown) => api(s.base, "PUT", "/search/config", body, tok);
const getStatus = async (s: TestServer, tok: string): Promise<any> => (await api(s.base, "GET", "/search/status", undefined, tok)).json;
const option = (st: any, id: string): any => st.options.find((o: any) => o.id === id);
const builtinEngine = (st: any, id: string): any => option(st, "builtin").engines.find((e: any) => e.id === id);

/** The full key must never appear in any response body, error text or stored file the test can see. */
function assertNoKeys(...texts: string[]): void {
  for (const t of texts) {
    assert.ok(!t.includes(KEY_BRAVE), "brave key leaked into a response");
    assert.ok(!t.includes(KEY_TAVILY), "tavily key leaked into a response");
  }
}

// ---------------------------------------------------------------- config, admin API, local admin

describe("search config API and local admin", () => {
  let s: TestServer;
  let admin = "";
  let user = "";
  before(async () => {
    s = await startServer(BASE);
    ({ admin, user } = await accounts(s));
  });
  after(() => s?.stop());

  test("GET /search/config reports the defaults and no key", async () => {
    const a = await api(s.base, "GET", "/search/config", undefined, admin);
    const u = await api(s.base, "GET", "/search/config", undefined, user);
    assert.equal(a.status, 200);
    assert.equal(u.status, 200, "any signed-in user can read the config");
    assert.equal(a.json.mode, "builtin", "no SearXNG URL means built-in");
    assert.equal(a.json.fallback, true);
    assert.deepEqual(a.json.keySet, { brave: false, tavily: false });
    assert.equal(a.json.searxngHost, null);
    assert.equal(a.json.searxngUrl, undefined);
    assert.deepEqual(a.json.engines, { builtin: ["bing-rss", "wikipedia", "duckduckgo"], api: ["brave", "tavily"] });
    assert.ok(!/"(braveApiKey|tavilyApiKey|keys)"/.test(a.text), "no key field in the response");
  });

  test("PUT /search/config is admin only and rejects bad values; a rejected body changes nothing", async () => {
    assert.equal((await putCfg(s, user, { mode: "api" })).status, 403);
    assert.equal((await api(s.base, "POST", "/search/test", { query: "x" }, user)).status, 403, "normal users cannot run the admin test");
    for (const bad of [
      { mode: "bogus" },
      { fallback: "yes" },
      { searxngUrl: "ftp://example.org" },
      { searxngUrl: "not a url" },
      { braveApiKey: "short" },
      { tavilyApiKey: "has a space in it" },
    ]) {
      assert.equal((await putCfg(s, admin, bad)).status, 400, JSON.stringify(bad));
    }
    // the body is validated as a whole before anything is written
    assert.equal((await putCfg(s, admin, { mode: "searxng", braveApiKey: "short" })).status, 400);
    assert.equal((await api(s.base, "GET", "/search/config", undefined, admin)).json.mode, "builtin");
  });

  test("an API key is stored, reported only as keySet, never echoed, and removed by null", async () => {
    const put = await putCfg(s, admin, { braveApiKey: KEY_BRAVE });
    assert.equal(put.status, 200, put.text);
    assert.equal(put.json.keySet.brave, true);
    const cfg = await api(s.base, "GET", "/search/config", undefined, admin);
    assert.equal(cfg.json.keySet.brave, true);
    assert.equal(cfg.json.keySet.tavily, false);

    // the brave answer fails (500) so the error text is produced and checked too
    setModes({ brave: "500" });
    const failing = await post(s, admin, { query: "tokyo", mode: "api" });
    assert.equal(failing.status, 502);
    const st = await getStatus(s, admin);
    assertNoKeys(put.text, cfg.text, failing.text, JSON.stringify(st));

    // the stored value is encrypted: the plain key is in neither the database file nor its WAL
    for (const f of ["t.db", "t.db-wal"]) {
      const p = join(s.tmp, f);
      if (existsSync(p)) assert.ok(!readFileSync(p).includes(KEY_BRAVE), `${f} holds the key in clear`);
    }

    const removed = await putCfg(s, admin, { braveApiKey: null });
    assert.equal(removed.status, 200);
    assert.equal(removed.json.keySet.brave, false);
  });

  test("local admin: full SearXNG URL, never keys; the loopback token is required", async () => {
    const tok = readFileSync(join(s.tmp, "local-admin.token"), "utf8").trim();
    const hdr = { "x-local-admin": tok };
    const sx = `${FAKE}/searxng`;

    const set = await putCfg(s, admin, { mode: "builtin", searxngUrl: sx });
    assert.equal(set.status, 200, set.text);
    assert.equal(set.json.searxngHost, `127.0.0.1:${PORT}`, "the public config shows the host only");
    assert.equal(set.json.searxngUrl, undefined);

    assert.equal((await api(s.base, "GET", "/local-admin/search/config", undefined, "", { "x-local-admin": "nope" })).status, 401);
    const g = await api(s.base, "GET", "/local-admin/search/config", undefined, "", hdr);
    assert.equal(g.status, 200, g.text);
    assert.equal(g.json.searxngUrl, sx, "local admin gets the full URL");
    assert.ok(g.json.status, "local admin config includes the status");

    const lk = await api(s.base, "PUT", "/local-admin/search/config", { braveApiKey: KEY_BRAVE, tavilyApiKey: KEY_TAVILY }, "", hdr);
    assert.equal(lk.status, 200, lk.text);
    assert.equal(lk.json.keySet.brave, true);
    assertNoKeys(g.text, lk.text, JSON.stringify(lk.json.status));

    const lt = await api(s.base, "POST", "/local-admin/search/test", { query: "tokyo tower", mode: "builtin" }, "", hdr);
    assert.equal(lt.status, 200, lt.text);
    assert.equal(lt.json.usedBackend, "builtin");
    assert.equal(lt.json.results.length > 0, true);
  });
});

// ---------------------------------------------------------------- built-in engines: merge, queries, status, caps

describe("built-in engines: merge, query handling, status, limits", () => {
  let s: TestServer;
  let admin = "";
  before(async () => {
    s = await startServer(BASE);
    ({ admin } = await accounts(s));
  });
  after(() => s?.stop());

  test("round-robin merge across engines, duplicates merged, trimmed to SEARCH_MAX_RESULTS", async () => {
    const r = await post(s, admin, { query: "東京タワー 高さ", mode: "builtin" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.usedBackend, "builtin");
    const res: Array<{ title: string; url: string }> = r.json.results;
    // bing rank 1, wikipedia rank 1, bing rank 2, wikipedia rank 2, then duckduckgo rank 2; duckduckgo rank 1 is a duplicate
    assert.deepEqual(res.map((x) => x.url), [
      "https://www.example.com/page-a?utm_source=newsletter",
      "https://ja.wikipedia.org/wiki/Wiki_one",
      "https://bing.example.org/two/",
      "https://ja.wikipedia.org/wiki/Wiki_two",
      "https://ddg.example.io/two",
    ]);
    assert.equal(res.filter((x) => x.url.includes("page-a")).length, 1, "the duplicate page appears once");
    assert.deepEqual(r.json.tried, [{ mode: "builtin", ok: true }]);
  });

  test("a Japanese query reaches each engine intact and URL-encoded", async () => {
    const q = "東京タワー 高さ";
    const r = await post(s, admin, { query: q, mode: "builtin" });
    assert.equal(r.status, 200, r.text);
    const bing = lastCall("bing");
    assert.equal(bing.url.searchParams.get("q"), q);
    assert.ok(bing.url.search.includes("%E6%9D%B1%E4%BA%AC%E3%82%BF%E3%83%AF%E3%83%BC"), "raw query is percent-encoded UTF-8");
    assert.equal(lastCall("wiki").url.searchParams.get("srsearch"), q);
    assert.equal(new URLSearchParams(lastCall("ddg").body).get("q"), q);
  });

  test("a query longer than 200 characters is cut before it leaves", async () => {
    const q = "x".repeat(150) + "東京".repeat(50);
    const r = await post(s, admin, { query: q, mode: "builtin" });
    assert.equal(r.status, 200, r.text);
    const sent = lastCall("bing").url.searchParams.get("q") ?? "";
    assert.equal(sent.length, 200);
    assert.equal(sent, q.slice(0, 200));
  });

  test("GET /search/status shape: three options, builtin engine list, active mode", async () => {
    const st = await getStatus(s, admin);
    assert.deepEqual(st.options.map((o: any) => o.id), ["searxng", "builtin", "api"]);
    for (const o of st.options) {
      assert.equal(typeof o.configured, "boolean");
      assert.equal(typeof o.state, "string");
    }
    assert.equal(option(st, "searxng").configured, false);
    assert.equal(option(st, "searxng").state, "disabled");
    assert.equal(option(st, "api").configured, false, "API mode needs a key");
    assert.equal(st.active, "builtin");
    assert.equal(st.mode, "builtin");
    assert.equal(st.fallback, true);
    assert.deepEqual(st.engines.map((e: any) => e.id), ["bing-rss", "wikipedia", "duckduckgo"]);
    assert.equal(builtinEngine(st, "bing-rss").state, "ok");
  });

  test("an empty DuckDuckGo page counts as blocked; the other engines still answer", async () => {
    setModes({ ddg: "empty" });
    const r = await post(s, admin, { query: "tokyo", mode: "builtin" });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.results.length > 0);
    const ddg = builtinEngine(await getStatus(s, admin), "duckduckgo");
    assert.equal(ddg.state, "error");
    assert.match(ddg.lastError, /blocked/);
    setModes({});
    await post(s, admin, { query: "tokyo", mode: "builtin" });
    assert.equal(builtinEngine(await getStatus(s, admin), "duckduckgo").state, "ok", "one success clears the error");
  });

  test("an answer over 1 MB counts as a failure, both declared and streamed", async () => {
    setModes({ bing: "big" });
    const a = await post(s, admin, { query: "tokyo", mode: "builtin" });
    assert.equal(a.status, 200, a.text);
    assert.match(builtinEngine(await getStatus(s, admin), "bing-rss").lastError, /too large/);

    setModes({ bing: "bigchunked" });
    const b = await post(s, admin, { query: "tokyo", mode: "builtin" });
    assert.equal(b.status, 200, b.text);
    assert.match(builtinEngine(await getStatus(s, admin), "bing-rss").lastError, /too large/);

    setModes({});
    await post(s, admin, { query: "tokyo", mode: "builtin" });
    assert.equal(builtinEngine(await getStatus(s, admin), "bing-rss").state, "ok");
  });

  test("a slow engine times out after SEARCH_ENGINE_TIMEOUT_MS and the others still answer", async () => {
    setModes({ bing: "delay" });
    const t0 = Date.now();
    const r = await post(s, admin, { query: "tokyo", mode: "builtin" });
    assert.equal(r.status, 200, r.text);
    assert.ok(Date.now() - t0 < 2400, "answered at the timeout, not after the 2.5 s delay");
    assert.match(builtinEngine(await getStatus(s, admin), "bing-rss").lastError, /timed out after 1500 ms/);
  });
});

// ---------------------------------------------------------------- failures and cooldown

describe("built-in engines: failures, cooldown, total failure", () => {
  let s: TestServer;
  let admin = "";
  before(async () => {
    s = await startServer(BASE);
    ({ admin } = await accounts(s));
  });
  after(() => s?.stop());

  test("a 429 and a CAPTCHA page count as failures; results still come from the rest", async () => {
    setModes({ bing: "429", ddg: "captcha" });
    const r = await post(s, admin, { query: "tokyo", mode: "builtin" });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.results.length > 0);
    assert.ok(r.json.results.every((x: any) => x.title.startsWith("Wiki")), "only Wikipedia answered");
    const st = await getStatus(s, admin);
    assert.equal(builtinEngine(st, "bing-rss").state, "error");
    assert.match(builtinEngine(st, "bing-rss").lastError, /429/);
    assert.equal(builtinEngine(st, "duckduckgo").state, "error");
    assert.match(builtinEngine(st, "duckduckgo").lastError, /blocked/);
    assert.equal(builtinEngine(st, "wikipedia").state, "ok");
  });

  test("three failures in a row put an engine in cooldown, and it then gets no requests", async () => {
    // the previous test was failure 1 for bing-rss and duckduckgo; these are failures 2 and 3 (beforeEach cleared the modes, so set them again)
    setModes({ bing: "429", ddg: "captcha" });
    for (let i = 0; i < 2; i++) assert.equal((await post(s, admin, { query: "tokyo", mode: "builtin" })).status, 200);
    const st = await getStatus(s, admin);
    assert.equal(builtinEngine(st, "bing-rss").state, "cooldown");
    assert.equal(builtinEngine(st, "duckduckgo").state, "cooldown");
    assert.match(builtinEngine(st, "bing-rss").lastError, /429/);

    const before = calls("bing").length;
    setModes({});
    assert.equal((await post(s, admin, { query: "tokyo", mode: "builtin" })).status, 200);
    assert.equal(calls("bing").length, before, "bing-rss received no request during cooldown");
    assert.equal(builtinEngine(await getStatus(s, admin), "bing-rss").state, "cooldown");
  });

  test("when every engine fails the search answers 502 and names each engine", async () => {
    setModes({ wiki: "500" });
    // bing-rss and duckduckgo are still cooling down; wikipedia fails three times and then cools down too
    for (let i = 0; i < 3; i++) {
      assert.equal((await post(s, admin, { query: "tokyo", mode: "builtin" })).status, 502);
    }
    const r = await post(s, admin, { query: "tokyo", mode: "builtin" });
    assert.equal(r.status, 502);
    for (const id of ["bing-rss", "wikipedia", "duckduckgo"]) assert.match(r.json.error, new RegExp(id));
    assert.equal(option(r.json.status, "builtin").state, "error");
  });
});

// ---------------------------------------------------------------- API engines (Brave, Tavily)

describe("API mode: Brave and Tavily", () => {
  let s: TestServer;
  let admin = "";
  before(async () => {
    s = await startServer(BASE);
    ({ admin } = await accounts(s));
  });
  after(() => s?.stop());

  test("mode api without keys is not configured", async () => {
    assert.equal((await putCfg(s, admin, { mode: "api" })).status, 200);
    const r = await post(s, admin, { query: "tokyo", mode: "api" });
    assert.equal(r.status, 502);
    assert.match(r.json.error, /no API key set/);
    assert.equal(option(await getStatus(s, admin), "api").configured, false);
    // without an explicit mode, fallback (on by default) answers from the built-in engines
    const f = await post(s, admin, { query: "tokyo" });
    assert.equal(f.status, 200, f.text);
    assert.equal(f.json.usedBackend, "builtin");
    assert.match(f.json.tried[0].error, /no API key set/);
  });

  test("with keys: Brave gets X-Subscription-Token, Tavily gets a Bearer token, results come back", async () => {
    const put = await putCfg(s, admin, { braveApiKey: KEY_BRAVE, tavilyApiKey: KEY_TAVILY });
    assert.equal(put.status, 200, put.text);
    const r = await post(s, admin, { query: "tokyo tower", mode: "api" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.usedBackend, "api");
    assert.equal(r.json.results.length, 4, "two results from each engine");
    assert.equal(lastCall("brave").headers["x-subscription-token"], KEY_BRAVE);
    assert.equal(lastCall("tavily").headers.authorization, `Bearer ${KEY_TAVILY}`);
    assert.equal(JSON.parse(lastCall("tavily").body).query, "tokyo tower");
    assert.equal(option(await getStatus(s, admin), "api").configured, true);
    assertNoKeys(r.text, put.text);
  });

  test("removing a key takes that engine out of the search", async () => {
    assert.equal((await putCfg(s, admin, { tavilyApiKey: null })).status, 200);
    const before = calls("tavily").length;
    const r = await post(s, admin, { query: "tokyo tower", mode: "api" });
    assert.equal(r.status, 200, r.text);
    assert.equal(calls("tavily").length, before, "tavily is not called without its key");
    assert.equal(r.json.results.length, 2, "Brave only");
  });
});

// ---------------------------------------------------------------- SearXNG and the fallback router

describe("SearXNG mode, fallback and switching", () => {
  let s: TestServer;
  let admin = "";
  before(async () => {
    s = await startServer(BASE);
    ({ admin } = await accounts(s));
    const set = await putCfg(s, admin, { mode: "searxng", searxngUrl: `${FAKE}/searxng`, fallback: true });
    assert.equal(set.status, 200, set.text);
  });
  after(() => s?.stop());

  test("a failing SearXNG falls back to the built-in engines and records why", async () => {
    setModes({ searxng: "500" });
    const r = await post(s, admin, { query: "tokyo" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.usedBackend, "builtin");
    assert.equal(r.json.tried[0].mode, "searxng");
    assert.equal(r.json.tried[0].ok, false);
    assert.match(r.json.tried[0].error, /SearXNG HTTP 500/);
    assert.deepEqual(r.json.tried[1], { mode: "builtin", ok: true });
  });

  test("with fallback off the same SearXNG failure is a 502", async () => {
    setModes({ searxng: "500" });
    assert.equal((await putCfg(s, admin, { fallback: false })).status, 200);
    const r = await post(s, admin, { query: "tokyo" });
    assert.equal(r.status, 502);
    assert.match(r.json.error, /SearXNG HTTP 500/);
  });

  test("an explicit mode never falls back, even with fallback on", async () => {
    setModes({ searxng: "500" });
    assert.equal((await putCfg(s, admin, { fallback: true })).status, 200);
    const bingBefore = calls("bing").length;
    const r = await post(s, admin, { query: "tokyo", mode: "searxng" });
    assert.equal(r.status, 502);
    assert.equal(calls("bing").length, bingBefore, "no built-in engine was tried");
    const b = await post(s, admin, { query: "tokyo", mode: "builtin" });
    assert.equal(b.status, 200);
    assert.equal(b.json.usedBackend, "builtin");
  });

  test("a healthy SearXNG answers and is named as the backend", async () => {
    setModes({ searxng: "ok" });
    const r = await post(s, admin, { query: "tokyo", mode: "searxng" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.usedBackend, "searxng");
    assert.equal(r.json.results[0].title, "SearXNG one");
  });

  test("switching the mode takes effect at once, without a restart", async () => {
    setModes({});
    assert.equal((await getStatus(s, admin)).active, "searxng");
    assert.equal((await putCfg(s, admin, { mode: "builtin" })).status, 200);
    assert.equal((await getStatus(s, admin)).active, "builtin");
    // API mode without keys is unusable; with fallback on the first usable mode in the order searxng, builtin, api is active
    assert.equal((await putCfg(s, admin, { mode: "api" })).status, 200);
    const st = await getStatus(s, admin);
    assert.equal(st.mode, "api");
    assert.equal(st.active, "searxng");
    assert.equal((await putCfg(s, admin, { mode: "builtin" })).status, 200);
    assert.equal((await getStatus(s, admin)).active, "builtin");
  });
});

// ---------------------------------------------------------------- SSRF / host rule and redirects

describe("engine host rule: loopback overrides only, no redirects", () => {
  let s: TestServer;
  let admin = "";
  before(async () => {
    s = await startServer({ ...BASE, OMNICHAT_SEARCH_BASE_BING_RSS: "http://example.com" });
    ({ admin } = await accounts(s));
  });
  after(() => s?.stop());

  test("an engine base override on a non-loopback host is refused as an engine error", async () => {
    const bingBefore = calls("bing").length;
    const r = await post(s, admin, { query: "tokyo", mode: "builtin" });
    assert.equal(r.status, 200, `the other engines still answer: ${r.text}`);
    assert.match(builtinEngine(await getStatus(s, admin), "bing-rss").lastError, /loopback/);
    assert.equal(calls("bing").length, bingBefore, "no request was sent to the non-loopback host");
  });

  test("a redirect from an upstream is refused and not followed", async () => {
    setModes({ ddg: "redirect" });
    const targetBefore = calls("target").length;
    const r = await post(s, admin, { query: "tokyo", mode: "builtin" });
    assert.equal(r.status, 200, r.text);
    assert.match(builtinEngine(await getStatus(s, admin), "duckduckgo").lastError, /redirect refused/);
    assert.equal(calls("target").length, targetBefore, "the redirect target was never requested");
  });
});

// ---------------------------------------------------------------- cache

describe("result cache", () => {
  let s: TestServer;
  let admin = "";
  before(async () => {
    s = await startServer({ ...BASE, OMNICHAT_SEARCH_CACHE_TTL_MS: "60000" });
    ({ admin } = await accounts(s));
  });
  after(() => s?.stop());

  test("the same query twice within the TTL reaches the upstream once", async () => {
    const first = await post(s, admin, { query: "cache me", mode: "builtin" });
    assert.equal(first.status, 200, first.text);
    const seen = log.length;
    assert.equal(calls("bing").filter((c) => c.url.searchParams.get("q") === "cache me").length, 1);
    const second = await post(s, admin, { query: "cache me", mode: "builtin" });
    assert.equal(second.status, 200, second.text);
    assert.equal(log.length, seen, "no upstream request for the repeat");
    assert.deepEqual(second.json.results, first.json.results);
  });
});
