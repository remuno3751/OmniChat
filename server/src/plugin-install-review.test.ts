// Review 2026-10 (docs/SECURITY-AUDIT-2026-10.md, findings I-*): regression tests for plugin-install.ts.
// Same shape as plugin-install.test.ts: a spawned server and a fake GitHub on a local port.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttp, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import JSZip from "jszip";

const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const PW = "password123";
let child: ChildProcess;
let base = "";
let tok = "";
let tmp = "";
let pluginsDir = "";
let gh: Server;

interface FakeRepo { head: string; versions: Map<string, Buffer>; onZipball?: () => void }
const repos = new Map<string, FakeRepo>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SHA = (n: number) => n.toString(16).padStart(40, "0");

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

async function makeZip(root: string, files: Record<string, string>): Promise<Buffer> {
  const z = new JSZip();
  for (const [p, c] of Object.entries(files)) z.file(`${root}/${p}`, c);
  return z.generateAsync({ type: "nodebuffer", platform: "UNIX" });
}

const pluginFiles = (id: string, version: string, markerPath?: string): Record<string, string> => ({
  "plugin.json": JSON.stringify({
    id, name: id, version, description: "d", main: "index.mjs",
    tools: [{ name: `${id.replace(/-/g, "_")}_tool`, description: "d", parameters: { type: "object", properties: {} }, permissions: [] }],
  }),
  "index.mjs": `${markerPath ? `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(markerPath)}, "loaded");\n` : ""}export const tools = { ${id.replace(/-/g, "_")}_tool: async () => "ok" };\n`,
});

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "omni-plugins-rev-"));
  pluginsDir = join(tmp, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  gh = createHttp((req, res) => {
    const u = new URL(req.url ?? "/", "http://fake");
    const m = /^\/repos\/([^/]+)\/([^/]+)\/(zipball|commits)(?:\/(.+))?$/.exec(u.pathname);
    const r = m ? repos.get(`${m[1]}/${m[2]}`) : undefined;
    if (!m || !r) { res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ message: "Not Found" })); return; }
    const ref = m[4] ? decodeURIComponent(m[4]) : null;
    const sha = ref && r.versions.has(ref) ? ref : r.head;
    if (m[3] === "zipball") {
      const zip = r.versions.get(sha)!;
      res.writeHead(200, { "content-type": "application/zip", "content-length": String(zip.length) }).end(zip);
      r.onZipball?.();
    } else {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sha }));
    }
  });
  await new Promise<void>((res) => gh.listen(0, "127.0.0.1", () => res()));
  const ghBase = `http://127.0.0.1:${(gh.address() as any).port}`;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    windowsHide: true,
    cwd: serverDir,
    env: {
      ...process.env, PORT: String(port), DB_PATH: join(tmp, "t.db"), PLUGINS_DIR: pluginsDir, OMNICHAT_GITHUB_API: ghBase,
      PLUGIN_ISOLATION: "inproc", OMNICHAT_OPEN_FIRST_REGISTRATION: "1", ALLOW_REGISTRATION: "1",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((res, rej) => {
    child.stdout!.on("data", (d) => { if (String(d).includes("listening")) res(); });
    child.once("exit", () => rej(new Error("server exited")));
  });
  const adm = await api("POST", "/auth/register", { username: "admin", password: PW, deviceName: "t", platform: "test" }, "");
  tok = adm.json.token;
  assert.ok(tok, "registration");
});

after(() => {
  child?.kill();
  gh?.close();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

const inspect = (repo: string) => api("POST", "/admin/plugins/inspect", { source: "github", repo });

test("I-1: an inspection id cannot be installed twice by parallel requests", async () => {
  repos.set("rev/once", { head: SHA(1), versions: new Map([[SHA(1), await makeZip("rev-once-1", pluginFiles("once-plugin", "1.0.0"))]]) });
  const i = await inspect("rev/once");
  assert.equal(i.status, 200, JSON.stringify(i.json));
  const body = { inspectionId: i.json.inspectionId, confirmId: "once-plugin" };
  const rs = await Promise.all([api("POST", "/admin/plugins/install", body), api("POST", "/admin/plugins/install", body), api("POST", "/admin/plugins/install", body)]);
  const codes = rs.map((r) => r.status).sort();
  assert.deepEqual(codes, [200, 410, 410], JSON.stringify(rs.map((r) => r.json)));
});

test("I-2: the commit sha recorded for an inspection is the commit of the zip that was inspected", async () => {
  const z1 = await makeZip("rev-race-1", pluginFiles("race-plugin", "1.0.0"));
  const z2 = await makeZip("rev-race-2", pluginFiles("race-plugin", "2.0.0"));
  const repo: FakeRepo = { head: SHA(11), versions: new Map([[SHA(11), z1], [SHA(12), z2]]) };
  // the branch moves right after the first zip download
  repo.onZipball = () => { repo.head = SHA(12); repo.onZipball = undefined; };
  repos.set("rev/race", repo);
  const r = await inspect("rev/race");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const want = r.json.manifest.version === "1.0.0" ? SHA(11) : SHA(12);
  assert.equal(r.json.source.commitSha, want, "commitSha must belong to the inspected content");
});

test("I-3: a new plugin is never loaded (code never runs) while it is being installed", async () => {
  let hits = 0;
  for (let n = 0; n < 10; n++) {
    const id = `race-load-${n}`;
    const marker = join(tmp, `marker-${id}`);
    repos.set(`rev/${id}`, { head: SHA(100 + n), versions: new Map([[SHA(100 + n), await makeZip(`rev-${id}`, pluginFiles(id, "1.0.0", marker))]]) });
    const i = await inspect(`rev/${id}`);
    assert.equal(i.status, 200, JSON.stringify(i.json));
    let done = false;
    const spam = async () => { while (!done) { await api("POST", "/tools/reload"); } };
    const spammers = [spam(), spam(), spam()];
    const inst = await api("POST", "/admin/plugins/install", { inspectionId: i.json.inspectionId, confirmId: id });
    done = true;
    await Promise.all(spammers);
    assert.equal(inst.status, 200, JSON.stringify(inst.json));
    await sleep(50);
    if (existsSync(marker)) hits++;
  }
  assert.equal(hits, 0, `${hits} of 10 freshly installed plugins ran their code before being enabled`);
});


const tool = (name: string, permissions: string[]) => ({ name, description: "d", parameters: { type: "object", properties: {} }, permissions });
const manifestFiles = (id: string, version: string, tools: unknown[]): Record<string, string> => ({
  "plugin.json": JSON.stringify({ id, name: id, version, description: "d", main: "index.mjs", tools }),
  "index.mjs": "export const tools = {};\n",
});

test("I-4: saved tool approvals do not carry over to a new tool name or to a tool that gained a permission", async () => {
  const db = new DatabaseSync(join(tmp, "t.db"));
  const adminId = (db.prepare("SELECT id FROM users WHERE is_admin = 1").get() as { id: string }).id;
  const grant = (name: string) => db.prepare("INSERT OR REPLACE INTO tool_grants (user_id, tool_name, granted_at) VALUES (?, ?, ?)").run(adminId, name, Date.now());
  const granted = (name: string) => !!db.prepare("SELECT 1 FROM tool_grants WHERE tool_name = ?").get(name);
  const install = async (repo: string, id: string) => {
    const i = await inspect(repo);
    assert.equal(i.status, 200, JSON.stringify(i.json));
    const r = await api("POST", "/admin/plugins/install", { inspectionId: i.json.inspectionId, confirmId: id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  };
  // a new plugin whose tool name already has saved approvals (they belonged to something else, e.g. a plugin that was disabled)
  grant("stale_tool");
  repos.set("rev/grants", { head: SHA(300), versions: new Map([[SHA(300), await makeZip("rev-grants-1", manifestFiles("grants-plugin", "1.0.0", [tool("stale_tool", []), tool("net_tool", ["network"])]))]]) });
  await install("rev/grants", "grants-plugin");
  assert.equal(granted("stale_tool"), false, "a new plugin starts without saved approvals");
  // the user approves net_tool for good; an update that adds a permission to it must ask again, one that does not keeps the approval
  grant("net_tool");
  repos.set("rev/grants", { head: SHA(301), versions: new Map([[SHA(301), await makeZip("rev-grants-2", manifestFiles("grants-plugin", "1.1.0", [tool("stale_tool", []), tool("net_tool", ["network"])]))]]) });
  await install("rev/grants", "grants-plugin");
  assert.equal(granted("net_tool"), true, "an update without new permissions keeps the approval");
  repos.set("rev/grants", { head: SHA(302), versions: new Map([[SHA(302), await makeZip("rev-grants-3", manifestFiles("grants-plugin", "2.0.0", [tool("stale_tool", []), tool("net_tool", ["network", "shell"])]))]]) });
  await install("rev/grants", "grants-plugin");
  assert.equal(granted("net_tool"), false, "a tool that gained a permission must be approved again");
  db.close();
});
