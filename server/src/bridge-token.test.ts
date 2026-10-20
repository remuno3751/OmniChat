import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import WebSocket from "ws";

const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");
let child: ChildProcess;
let port = 0;
let tmp = "";
let base = "";
let token = "";
let logs = "";

// State shared between the ordered tests below.
let bridgeTok = "";
let bridgeDeviceId = "";
let bridgeWs: WebSocket | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (f: () => Promise<boolean>, ms = 5000) => {
  const t = Date.now();
  while (!(await f())) { if (Date.now() - t > ms) throw new Error("timeout"); await sleep(20); }
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
    cwd: serverDir,
    // ALLOW_REGISTRATION lets the rate-limit test create a second user.
    env: { ...process.env, PORT: String(port), DB_PATH: join(tmp, "t.db"), ALLOW_REGISTRATION: "1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((res, rej) => {
    child.stdout!.on("data", (d) => { logs += String(d); if (String(d).includes("listening")) res(); });
    child.once("exit", () => rej(new Error("server exited")));
  });
  const r = await api("POST", "/auth/register", { username: "tester", password: "password123" }, "");
  token = r.json.token;
});
after(() => {
  bridgeWs?.terminate();
  child?.kill();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("creates a token that authenticates HTTP and the /bridge socket", async () => {
  const r = await api("POST", "/bridges/token", { name: "PC" });
  assert.equal(r.status, 200);
  bridgeTok = r.json.token;
  bridgeDeviceId = r.json.deviceId;
  assert.match(bridgeTok, /^[0-9a-f]{64}$/);
  assert.ok(bridgeDeviceId);
  assert.equal(r.json.name, "DSH plugin (PC)");

  // HTTP auth with the new token.
  const devs = await api("GET", "/devices", undefined, bridgeTok);
  assert.equal(devs.status, 200);
  assert.ok(devs.json.devices.some((d: any) => d.id === bridgeDeviceId && d.current));

  // Bridge socket with the new token.
  bridgeWs = await open(`ws://127.0.0.1:${port}/bridge?token=${bridgeTok}&name=pc`);
  bridgeWs.send(JSON.stringify({ type: "ready", name: "pc", cwd: "C:\\work" }));
  await waitFor(async () => {
    const b = (await api("GET", "/bridges")).json.bridges as any[];
    return b.some((x) => x.name === "pc" && x.cwd === "C:\\work" && x.online === true);
  });
});

test("device appears in GET /devices without the token or its hash", async () => {
  const r = await api("GET", "/devices");
  const dev = r.json.devices.find((d: any) => d.id === bridgeDeviceId);
  assert.ok(dev, "device listed");
  assert.equal(dev.name, "DSH plugin (PC)");
  const text = JSON.stringify(r.json);
  assert.ok(!text.includes(bridgeTok), "token not in response");
  assert.ok(!text.includes(createHash("sha256").update(bridgeTok).digest("hex")), "hash not in response");
  assert.ok(!text.includes("token_hash") && !text.includes("tokenHash"), "no hash field");
  assert.ok(!logs.includes(bridgeTok), "token not logged by the server");
});

test("DELETE /devices/:id closes the bridge with 4001 and the token then gets 401", async () => {
  assert.ok(bridgeWs, "bridge connected in previous test");
  const closed = new Promise<number>((res) => bridgeWs!.once("close", (code) => res(code)));
  const del = await api("DELETE", `/devices/${bridgeDeviceId}`);
  assert.equal(del.status, 200);
  assert.equal(await closed, 4001);
  bridgeWs = null;
  assert.equal((await api("GET", "/devices", undefined, bridgeTok)).status, 401);
});

test("401 without auth", async () => {
  assert.equal((await api("POST", "/bridges/token", { name: "PC" }, "")).status, 401);
  assert.equal((await api("POST", "/bridges/token", { name: "PC" }, "nope")).status, 401);
});

test("name sanitation: control chars stripped, clipped to 40, non-string -> PC", async () => {
  const ctl = await api("POST", "/bridges/token", { name: "  my\u0007pc\r\nnew\tline  " });
  assert.equal(ctl.status, 200);
  assert.equal(ctl.json.name, "DSH plugin (my pc new line)");

  const long = await api("POST", "/bridges/token", { name: "x".repeat(100) });
  assert.equal(long.json.name, `DSH plugin (${"x".repeat(40)})`);

  const num = await api("POST", "/bridges/token", { name: 123 });
  assert.equal(num.json.name, "DSH plugin (PC)");

  const blank = await api("POST", "/bridges/token", { name: "   \n " });
  assert.equal(blank.json.name, "DSH plugin (PC)");

  const none = await api("POST", "/bridges/token", {});
  assert.equal(none.json.name, "DSH plugin (PC)");
});

test("rate limit: 10 tokens per hour per user, 11th gets 429", async () => {
  // Fresh user so the count starts at zero regardless of the tests above.
  const reg = await api("POST", "/auth/register", { username: "tester2", password: "password123" }, "");
  assert.equal(reg.status, 200);
  const tok2 = reg.json.token;

  for (let i = 0; i < 10; i++) {
    const r = await api("POST", "/bridges/token", { name: `PC${i}` }, tok2);
    assert.equal(r.status, 200, `creation ${i + 1}`);
  }
  const over = await api("POST", "/bridges/token", { name: "PC" }, tok2);
  assert.equal(over.status, 429);
  assert.equal(over.json.error, "Too many tokens created, try again later");

  // The limit is per user: the first user can still create.
  assert.equal((await api("POST", "/bridges/token", { name: "PC" })).status, 200);
});
