// VS Code bridge over the real server process: token (S10), GET /bridges (S3), provider kind (S1), revoke = 4001.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startServer, api, openWs, sleep, type TestServer } from "./test-server.js";

let s: TestServer;
let tok = "";
const call = (m: string, p: string, b?: unknown, t = tok) => api(s.base, m, p, b, t);
const until = async (f: () => boolean, ms = 4000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timeout"); await sleep(20); } };

before(async () => {
  s = await startServer({ ALLOW_REGISTRATION: "1" });
  tok = (await api(s.base, "POST", "/auth/register", { username: "vsuser", password: "password123" })).json.token;
});
after(() => s?.stop());

const ready = (name: string, instance: string, over: Record<string, unknown> = {}) => ({
  type: "ready", kind: "vscode", name, instance, version: "0.1.0", protocol: 1, vscodeVersion: "1.96.0", platform: "linux", shell: "bash",
  remote: null, cwd: "/work/a", workspaces: ["/work/a"], allowAnyCwd: false, trusted: true,
  capabilities: { workspaces: true, fs: false, approval: true, checkpoints: true, transcript: false, tools: ["read_file"] }, ...over,
});

test("POST /bridges/token kind:vscode names the device 'VS Code (<name>)'; default stays the DSH plugin", async () => {
  const v = await call("POST", "/bridges/token", { name: "Laptop", kind: "vscode" });
  assert.equal(v.status, 200);
  assert.equal(v.json.name, "VS Code (Laptop)");
  assert.match(v.json.token, /^[0-9a-f]{64}$/);
  const d = await call("POST", "/bridges/token", { name: "Laptop" });
  assert.equal(d.json.name, "DSH plugin (Laptop)");
});

test("GET /bridges merges instances of one name; revoking the device closes the socket with 4001", async () => {
  const t = (await call("POST", "/bridges/token", { name: "Box", kind: "vscode" })).json;
  const w1 = await openWs(`${s.base.replace("http", "ws")}/bridge?token=${t.token}&name=Box&kind=vscode&instance=i1`);
  const w2 = await openWs(`${s.base.replace("http", "ws")}/bridge?token=${t.token}&name=Box&kind=vscode&instance=i2`);
  const welcomes: any[] = [];
  w1.on("message", (r) => welcomes.push(JSON.parse(r.toString())));
  w1.send(JSON.stringify(ready("Box", "i1")));
  w2.send(JSON.stringify(ready("Box", "i2", { cwd: "/work/b", workspaces: ["/work/b"] })));
  await until(() => welcomes.some((f) => f.type === "welcome"));
  await sleep(150);
  const list = (await call("GET", "/bridges")).json.bridges.filter((b: any) => b.name === "Box");
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, "vscode");
  assert.deepEqual([...list[0].workspaces].sort(), ["/work/a", "/work/b"]);
  assert.deepEqual(list[0].compat, { ok: true, minVersion: "0.1.0" });
  assert.equal(list[0].busy, false);
  let code = -1;
  w1.on("close", (c) => { code = c; });
  assert.equal((await call("DELETE", `/devices/${t.deviceId}`)).status, 200);
  await until(() => code !== -1);
  assert.equal(code, 4001);
  w2.terminate();
});

test("vscode-bridge provider: validated on create/update, conversations default to code, ephemeral refused", async () => {
  const id = randomUUID();
  const bad1 = await call("PUT", `/providers/${id}`, { name: "VS", kind: "vscode-bridge", baseUrl: "Box", model: "x", apiKey: "secret" });
  assert.equal(bad1.status, 400);
  const bad2 = await call("PUT", `/providers/${id}`, { name: "VS", kind: "vscode-bridge", baseUrl: "   ", model: "x" });
  assert.equal(bad2.status, 400);
  const ok = await call("PUT", `/providers/${id}`, { name: "VS", kind: "vscode-bridge", baseUrl: "Box", model: "x" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.kind, "vscode-bridge");
  assert.equal(ok.json.hasKey, false);
  // a bridge name is not a URL: no outbound-url check; update with a key is refused as well
  assert.equal((await call("PUT", `/providers/${id}`, { name: "VS", kind: "vscode-bridge", baseUrl: "Box", model: "x", apiKey: "k" })).status, 400);
  const conv = randomUUID();
  const c = await call("PUT", `/conversations/${conv}`, { providerId: id, model: `${randomUUID()}::m` });
  assert.equal(c.status, 200);
  assert.equal(c.json.mode, "code");
  const eph = await call("PUT", `/conversations/eph_${randomUUID()}`, { ephemeral: true, providerId: id });
  assert.equal(eph.status, 400);
  assert.match(eph.json.error ?? eph.text, /Ephemeral chats do not support vscode-bridge providers/);
});
