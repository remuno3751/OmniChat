import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createNet, type AddressInfo } from "node:net";
import { createServer as createHttp, type Server } from "node:http";

const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const freePort = () => new Promise<number>((res) => { const s = createNet().listen(0, () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); }); });

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const BIG = Buffer.concat([PNG, Buffer.alloc(2_500_000)]);

// ---- fake Hugging Face (also serves the avatar CDN) ----
const hfCalls: string[] = [];
let hfBase = "";
const hf: Server = createHttp((req, rsp) => {
  const u = new URL(req.url ?? "/", "http://fake");
  const p = u.pathname;
  hfCalls.push(p + u.search);
  const json = (code: number, body: unknown) => { rsp.writeHead(code, { "content-type": "application/json" }); rsp.end(JSON.stringify(body)); };
  const org = /^\/api\/organizations\/([^/]+)\/avatar$/.exec(p)?.[1];
  if (org) {
    const avatars: Record<string, string> = {
      google: `${hfBase}/cdn/google.png`,
      acme: `${hfBase}/cdn/acme.png`,
      acme2: `${hfBase}/cdn/acme2.png`,
      "org-x": `${hfBase}/cdn/org-x.png`,
      evil: "http://evil.example/x.png",
      redir: `${hfBase}/cdn/redirect-evil`,
      big: `${hfBase}/cdn/big.png`,
    };
    return avatars[org] ? json(200, { avatarUrl: avatars[org] }) : json(404, { error: "nf" });
  }
  if (p.startsWith("/api/users/")) return json(404, { error: "nf" });
  if (p === "/cdn/big.png") { rsp.writeHead(200, { "content-type": "image/png", "content-length": String(BIG.length) }); return rsp.end(BIG); }
  if (p === "/cdn/redirect-evil") { rsp.writeHead(302, { location: "http://evil.example/x.png" }); return rsp.end(); }
  if (/^\/cdn\/[\w-]+\.png$/.test(p)) { rsp.writeHead(200, { "content-type": "image/png" }); return rsp.end(PNG); }
  if (p === "/api/models") return json(200, u.searchParams.get("search") === "weird-model-1b" ? [{ id: "mradermacher/weird-model-1b-GGUF" }] : []);
  if (p === "/api/models/mradermacher/weird-model-1b-GGUF") return json(200, { id: "mradermacher/weird-model-1b-GGUF", cardData: { base_model: ["acme/weird-model-1b"] } });
  json(404, { error: "nf" });
});

const children: ChildProcess[] = [];
const tmps: string[] = [];
const newTmp = () => { const d = mkdtempSync(join(tmpdir(), "omni-logos-")); tmps.push(d); return d; };

type Child = { base: string; token: string; dir: string };

/** Spawns a real server with the given logo env and registers one device. */
async function startChild(dir: string, env: Record<string, string>): Promise<Child> {
  const port = await freePort();
  const proc = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    windowsHide: true,
    cwd: serverDir,
    env: {
      ...process.env,
      ALLOW_REGISTRATION: "1",
      PORT: String(port),
      DATA_DIR: dir,
      DB_PATH: join(dir, "t.db"),
      OMNICHAT_LOCAL_PROBES: "[]",
      ...env,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(proc);
  await new Promise<void>((res, rej) => {
    proc.stdout!.on("data", (d) => { if (String(d).includes("listening")) res(); });
    proc.once("exit", () => rej(new Error("server exited")));
  });
  const base = `http://127.0.0.1:${port}`;
  const reg = await fetch(`${base}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "logo", password: "password123", deviceName: "test", platform: "test" }),
  });
  const token = ((await reg.json()) as any).token as string;
  return { base, token, dir };
}

async function logo(c: Child, params: Record<string, string>, auth = true) {
  const r = await fetch(`${c.base}/model-logo?${new URLSearchParams(params)}`, { headers: auth ? { authorization: `Bearer ${c.token}` } : {} });
  return { status: r.status, type: r.headers.get("content-type"), cache: r.headers.get("cache-control"), body: Buffer.from(await r.arrayBuffer()) };
}

const logosDir = (c: Child) => join(c.dir, "cache", "model-logos");

// Start the fake HF first so its port is known to the children.
await new Promise<void>((res) => hf.listen(0, "127.0.0.1", res));
hfBase = `http://127.0.0.1:${(hf.address() as AddressInfo).port}`;
const hfEnv = { OMNICHAT_HF_BASE: hfBase, OMNICHAT_HF_CDN_ALLOW: hfBase.replace(/^http:\/\//, "") };

after(() => {
  for (const c of children) c.kill();
  hf.closeAllConnections();
  hf.close();
  for (const d of tmps) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
});

// ---- enabled: resolution, caching, guards ----

const main = await startChild(newTmp(), { ...hfEnv, OMNICHAT_MODEL_LOGOS: "1" });

test("family table resolves gemma to google without searching", async () => {
  hfCalls.length = 0;
  const r = await logo(main, { model: "gemma-3-12b-it" });
  assert.equal(r.status, 200);
  assert.equal(r.type, "image/png");
  assert.equal(r.cache, "private, max-age=604800");
  assert.deepEqual(r.body, PNG);
  assert.ok(hfCalls.includes("/api/organizations/google/avatar"));
  assert.ok(!hfCalls.some((c) => c.startsWith("/api/models")), "no search for a family match");
});

test("re-packager publishers are skipped", async () => {
  hfCalls.length = 0;
  const a = await logo(main, { model: "gemma-3-12b-it", publisher: "lmstudio-community" });
  assert.equal(a.status, 200);
  assert.ok(!hfCalls.some((c) => c.includes("/lmstudio-community/")));
  hfCalls.length = 0;
  const b = await logo(main, { model: "zzz-unknown-7b", publisher: "mradermacher" });
  assert.equal(b.status, 404);
  assert.deepEqual(JSON.parse(b.body.toString()), { error: "not found" });
  assert.ok(hfCalls.includes("/api/models?search=zzz-unknown-7b&limit=5"), "unknown name goes to search");
  assert.ok(!hfCalls.some((c) => c.startsWith("/api/organizations/mradermacher")));
});

test("search finds base_model, then the disk cache serves repeats", async () => {
  hfCalls.length = 0;
  const r = await logo(main, { model: "weird-model-1b", publisher: "mradermacher" });
  assert.equal(r.status, 200);
  assert.deepEqual(hfCalls, [
    "/api/models?search=weird-model-1b&limit=5",
    "/api/models/mradermacher/weird-model-1b-GGUF",
    "/api/organizations/acme/avatar",
    "/cdn/acme.png",
  ]);
  assert.ok(existsSync(join(logosDir(main), "acme.png")), "avatar stored on disk");
  const index = JSON.parse(readFileSync(join(logosDir(main), "index.json"), "utf8"));
  assert.equal(index.acme.file, "acme.png");
  hfCalls.length = 0;
  const again = await logo(main, { model: "weird-model-1b", publisher: "mradermacher" });
  assert.deepEqual(again.body, PNG);
  assert.equal(hfCalls.length, 0, "no upstream calls on repeat");
});

test("a publisher or an org prefix that is not a re-packager is used directly", async () => {
  hfCalls.length = 0;
  const a = await logo(main, { model: "tiny-thing", publisher: "acme2" });
  assert.equal(a.status, 200);
  assert.ok(hfCalls.includes("/api/organizations/acme2/avatar"));
  assert.ok(!hfCalls.some((c) => c.startsWith("/api/models")));
  hfCalls.length = 0;
  const b = await logo(main, { model: "org-x/some-model" });
  assert.equal(b.status, 200);
  assert.ok(hfCalls.includes("/api/organizations/org-x/avatar"));
});

test("an organization without an avatar is negatively cached", async () => {
  hfCalls.length = 0;
  const a = await logo(main, { model: "nobody-q/foo" });
  const b = await logo(main, { model: "nobody-q/foo" });
  assert.equal(a.status, 404);
  assert.equal(b.status, 404);
  assert.equal(hfCalls.filter((c) => c === "/api/organizations/nobody-q/avatar").length, 1);
});

test("avatar hosts outside Hugging Face are refused, including via redirect", async () => {
  hfCalls.length = 0;
  const direct = await logo(main, { model: "evil/tool" });
  assert.equal(direct.status, 404);
  const viaRedirect = await logo(main, { model: "redir/tool" });
  assert.equal(viaRedirect.status, 404);
  assert.ok(hfCalls.includes("/cdn/redirect-evil"));
  assert.ok(!hfCalls.some((c) => c.includes("evil.example")));
});

test("avatars over 2 MB are refused", async () => {
  const r = await logo(main, { model: "big/tool" });
  assert.equal(r.status, 404);
});

test("auth and input validation", async () => {
  assert.equal((await logo(main, { model: "gemma-3-12b-it" }, false)).status, 401);
  assert.equal((await logo(main, { model: "" })).status, 400);
  assert.equal((await logo(main, { model: "x".repeat(301) })).status, 400);
  assert.equal((await logo(main, { model: "gemma-3-12b-it", publisher: "p".repeat(101) })).status, 400);
});

// ---- OMNICHAT_MODEL_LOGOS=0: no outbound calls, only cached files ----

test("OMNICHAT_MODEL_LOGOS=0 on a fresh data dir makes zero upstream calls", async () => {
  const off = await startChild(newTmp(), { ...hfEnv, OMNICHAT_MODEL_LOGOS: "0" });
  hfCalls.length = 0;
  assert.equal((await logo(off, { model: "gemma-3-12b-it" })).status, 404);
  assert.equal((await logo(off, { model: "weird-model-1b", publisher: "mradermacher" })).status, 404);
  assert.equal((await logo(off, { model: "org-x/some-model" })).status, 404);
  assert.equal(hfCalls.length, 0);
});

test("OMNICHAT_MODEL_LOGOS=0 still serves a pre-seeded cached logo", async () => {
  const dir = newTmp();
  mkdirSync(join(dir, "cache", "model-logos"), { recursive: true });
  writeFileSync(join(dir, "cache", "model-logos", "google.png"), "SEEDED");
  writeFileSync(join(dir, "cache", "model-logos", "index.json"), JSON.stringify({ google: { file: "google.png", contentType: "image/png", fetchedAt: Date.now() } }));
  const off = await startChild(dir, { ...hfEnv, OMNICHAT_MODEL_LOGOS: "0" });
  hfCalls.length = 0;
  const hit = await logo(off, { model: "gemma-3-12b-it" });
  assert.equal(hit.status, 200);
  assert.equal(hit.body.toString(), "SEEDED");
  assert.equal((await logo(off, { model: "acme/whatever" })).status, 404);
  assert.equal(hfCalls.length, 0);
});
