// Plugin install from GitHub (docs/PROTOCOL-v7-plugins.md): a spawned server, a fake GitHub on a local port.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttp, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import JSZip from "jszip";

const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const PW = "password123";
const TTL_MS = 2000;
let child: ChildProcess;
let port = 0;
let tmp = "";
let base = "";
let tok = "";
let memberTok = "";
let adminId = "";
let pluginsDir = "";
let marker = "";
let dbPath = "";
let gh: Server;
let ghBase = "";

const repos = new Map<string, { sha: string; zip: Buffer }>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/* ---------- fake GitHub ---------- */

const SHA = (n: number) => n.toString(16).padStart(40, "0");

/** A GitHub-style zipball: everything under one "owner-repo-sha/" folder. */
async function makeZip(root: string, files: Record<string, string | Buffer>, extra?: (z: JSZip) => void): Promise<Buffer> {
  const z = new JSZip();
  for (const [p, c] of Object.entries(files)) z.file(`${root}/${p}`, c);
  extra?.(z);
  return z.generateAsync({ type: "nodebuffer", platform: "UNIX" });
}

function setRepo(repo: string, sha: string, zip: Buffer): void {
  repos.set(repo, { sha, zip });
}

const helloPlugin = (version: string, extraTool = false): Record<string, string> => ({
  "plugin.json": JSON.stringify({
    id: "hello-plugin", name: "Hello", version, description: "says hi", main: "index.mjs",
    tools: [
      { name: "hello_tool", description: "say hi", parameters: { type: "object", properties: {} }, permissions: [] },
      ...(extraTool ? [{ name: "bye_tool", description: "say bye", parameters: { type: "object", properties: {} }, permissions: ["network"] }] : []),
    ],
  }),
  "index.mjs": extraTool
    ? `import { writeFileSync } from "node:fs";\nimport { greet } from "./lib/util.mjs";\nwriteFileSync(process.env.OMNICHAT_TEST_MARKER, "loaded");\nexport const tools = { hello_tool: async () => greet(), bye_tool: async () => "bye" };\n`
    : `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.OMNICHAT_TEST_MARKER, "loaded");\nexport const tools = { hello_tool: async () => "hi from hello" };\n`,
  ...(extraTool ? { "lib/util.mjs": `export const greet = () => "hi v2";\n` } : {}),
});

const manifestOnly = (id: string, tools: unknown[], extra: Record<string, string> = {}): Record<string, string> => ({
  "plugin.json": JSON.stringify({ id, name: id, version: "0.1.0", description: "d", main: "index.mjs", tools }),
  "index.mjs": `export const tools = {};\n`,
  ...extra,
});

const tool = (name: string, permissions: string[] = []) => ({ name, description: "d", parameters: { type: "object", properties: {} }, permissions });

/* ---------- lifecycle ---------- */

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "omni-plugins-"));
  pluginsDir = join(tmp, "plugins");
  marker = join(tmp, "marker.txt");
  dbPath = join(tmp, "t.db");
  mkdirSync(pluginsDir, { recursive: true });

  // a hand-placed plugin (no install row): loaded as it is, and never manageable here
  mkdirSync(join(pluginsDir, "manual-plugin"));
  writeFileSync(join(pluginsDir, "manual-plugin", "plugin.json"), JSON.stringify({
    id: "manual-plugin", name: "Manual", version: "0.0.1", description: "by hand", main: "index.mjs", tools: [tool("manual_tool")],
  }));
  writeFileSync(join(pluginsDir, "manual-plugin", "index.mjs"), `export const tools = { manual_tool: async () => "manual" };\n`);

  // the fake GitHub
  gh = createHttp(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://fake");
    const m = /^\/repos\/([^/]+)\/([^/]+)\/(zipball|commits)(?:\/(.+))?$/.exec(u.pathname);
    const repo = m ? `${m[1]}/${m[2]}` : "";
    const ref = m?.[4] ? decodeURIComponent(m[4]) : null;
    const r = m ? repos.get(repo) : undefined;
    if (!m || !r || ref === "missing") {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ message: "Not Found" }));
      return;
    }
    if (m[3] === "zipball") {
      res.writeHead(200, { "content-type": "application/zip", "content-length": String(r.zip.length) }).end(r.zip);
    } else {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sha: r.sha }));
    }
  });
  await new Promise<void>((res) => gh.listen(0, "127.0.0.1", () => res()));
  ghBase = `http://127.0.0.1:${(gh.address() as any).port}`;

  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    windowsHide: true,
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      PLUGINS_DIR: pluginsDir,
      OMNICHAT_GITHUB_API: ghBase,
      OMNICHAT_PLUGIN_INSPECTION_TTL_MS: String(TTL_MS),
      OMNICHAT_TEST_MARKER: marker,
      // this file checks the stage 1 import-on-enable behaviour; installed plugins are process-isolated by default
      // (stage 2) and start lazily, which plugin-sandbox.test.ts covers
      PLUGIN_ISOLATION: "inproc",
      OMNICHAT_OPEN_FIRST_REGISTRATION: "1",
      ALLOW_REGISTRATION: "1",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((res, rej) => {
    child.stdout!.on("data", (d) => { if (String(d).includes("listening")) res(); });
    child.once("exit", () => rej(new Error("server exited")));
  });
  // the first account is the administrator
  const adm = await api("POST", "/auth/register", { username: "admin", password: PW, deviceName: "t", platform: "test" }, "");
  tok = adm.json.token;
  const mem = await api("POST", "/auth/register", { username: "member", password: PW, deviceName: "t", platform: "test" }, "");
  memberTok = mem.json.token;
  assert.ok(tok && memberTok, "registration");
  const me = new DatabaseSync(dbPath).prepare("SELECT id FROM users WHERE is_admin = 1").get() as { id: string };
  adminId = me.id;
});

after(() => {
  child?.kill();
  gh?.close();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

/* ---------- helpers for the tests ---------- */

async function inspect(repo: string, ref?: string, subdir?: string, t = tok) {
  return api("POST", "/admin/plugins/inspect", { source: "github", repo, ...(ref ? { ref } : {}), ...(subdir ? { subdir } : {}) }, t);
}
const listPlugins = async () => (await api("GET", "/admin/plugins")).json.plugins as any[];
const pluginRow = async (id: string) => (await listPlugins()).find((p) => p.id === id);
const toolsList = async () => (await api("GET", "/tools")).json.tools as any[];

/* ---------- tests ---------- */

test("inspect a GitHub repo returns the manifest, scan and files without installing", async () => {
  setRepo("fake/hello", SHA(1), await makeZip("fake-hello-1", helloPlugin("1.0.0")));
  const r = await inspect("fake/hello");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.inspectionId, /^[0-9a-f-]{36}$/);
  assert.equal(r.json.source.repo, "fake/hello");
  assert.equal(r.json.source.commitSha, SHA(1));
  assert.equal(r.json.manifest.id, "hello-plugin");
  assert.equal(r.json.manifest.tools[0].name, "hello_tool");
  assert.equal(r.json.alreadyInstalled, false);
  assert.deepEqual(r.json.files.map((f: any) => f.path), ["index.mjs", "plugin.json"]);
  assert.ok(r.json.scan.findings.some((f: any) => f.rule === "env_access" || f.rule === "fs_write"));
  assert.ok(r.json.warnings.some((w: string) => w.includes("無効")));
  assert.equal(existsSync(join(pluginsDir, "hello-plugin")), false, "nothing written by inspect");
});

test("install needs the exact id as confirmId", async () => {
  const i = await inspect("fake/hello");
  const r = await api("POST", "/admin/plugins/install", { inspectionId: i.json.inspectionId, confirmId: "hello" });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "confirm_mismatch");
  assert.equal(existsSync(join(pluginsDir, "hello-plugin")), false);
});

test("install lands disabled and the module is not executed until enabled", async () => {
  const i = await inspect("fake/hello");
  const r = await api("POST", "/admin/plugins/install", { inspectionId: i.json.inspectionId, confirmId: "hello-plugin" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.plugin.id, "hello-plugin");
  assert.equal(r.json.plugin.enabled, false);
  assert.equal(r.json.plugin.source, "github");
  assert.equal(r.json.plugin.commitSha, SHA(1));
  assert.ok(existsSync(join(pluginsDir, "hello-plugin", "plugin.json")));
  assert.equal(existsSync(marker), false, "module must not run while disabled");
  // a disabled plugin is one problem entry (keyed by the plugin id), and its module is not registered
  const probs = (await toolsList()).filter((x) => x.pluginId === "hello-plugin");
  assert.equal(probs.length, 1);
  assert.equal(probs[0].available, false);
  assert.equal(probs[0].error, "disabled by the administrator");
  assert.equal((await toolsList()).some((x) => x.name === "hello_tool"), false);
  // single use
  const again = await api("POST", "/admin/plugins/install", { inspectionId: i.json.inspectionId, confirmId: "hello-plugin" });
  assert.equal(again.status, 410);
  assert.equal(again.json.code, "inspection_expired");
});

test("enable imports the module; disable removes it again", async () => {
  const on = await api("PATCH", "/admin/plugins/hello-plugin", { enabled: true });
  assert.equal(on.status, 200, JSON.stringify(on.json));
  assert.equal(on.json.plugin.enabled, true);
  assert.equal(existsSync(marker), true, "module ran on enable");
  const t = (await toolsList()).find((x) => x.name === "hello_tool");
  assert.equal(t.available, true);
  rmSync(marker);
  const off = await api("PATCH", "/admin/plugins/hello-plugin", { enabled: false });
  assert.equal(off.json.plugin.enabled, false);
  const t2 = (await toolsList()).find((x) => x.pluginId === "hello-plugin");
  assert.equal(t2.error, "disabled by the administrator");
  assert.equal(existsSync(marker), false, "disabled plugin is not re-imported");
  await api("PATCH", "/admin/plugins/hello-plugin", { enabled: true });
  assert.equal(existsSync(marker), true);
});

test("a modified file on disk is reported", async () => {
  const f = join(pluginsDir, "hello-plugin", "index.mjs");
  writeFileSync(f, readFileSync(f, "utf8") + "\n// tweaked by hand\n");
  const row = await pluginRow("hello-plugin");
  assert.equal(row.modified, true);
});

test("check-update: no new commit means no update; a new commit shows the diff", async () => {
  // the folder was tweaked, so reinstall the same commit first to get back to a clean state
  const same = await api("POST", "/admin/plugins/hello-plugin/check-update");
  assert.equal(same.status, 200);
  assert.equal(same.json.updateAvailable, false);
  assert.equal(same.json.latestCommitSha, SHA(1));

  setRepo("fake/hello", SHA(2), await makeZip("fake-hello-2", helloPlugin("2.0.0", true)));
  const up = await api("POST", "/admin/plugins/hello-plugin/check-update");
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.equal(up.json.updateAvailable, true);
  assert.equal(up.json.latestCommitSha, SHA(2));
  assert.equal(up.json.manifest.version, "2.0.0");
  assert.deepEqual(up.json.diff.added, ["lib/util.mjs"]);
  assert.deepEqual(up.json.diff.changed, ["index.mjs", "plugin.json"]);
  assert.deepEqual(up.json.diff.toolsAdded, ["bye_tool"]);
  assert.deepEqual(up.json.diff.toolsRemoved, []);
  assert.deepEqual(up.json.diff.permissionsAdded, [{ tool: "bye_tool", permission: "network" }]);

  const inst = await api("POST", "/admin/plugins/install", { inspectionId: up.json.inspectionId, confirmId: "hello-plugin" });
  assert.equal(inst.status, 200, JSON.stringify(inst.json));
  assert.equal(inst.json.plugin.commitSha, SHA(2));
  assert.equal(inst.json.plugin.enabled, true, "an update keeps the enabled state");
  const row = await pluginRow("hello-plugin");
  assert.equal(row.modified, false, "the update replaced the hand-tweaked file");
  assert.equal(row.version, "2.0.0");
  assert.ok((await toolsList()).some((x) => x.name === "bye_tool" && x.available));
});

test("refuses a plugin with dependencies", async () => {
  setRepo("fake/deps", SHA(3), await makeZip("fake-deps-1", {
    ...manifestOnly("deps-plugin", [tool("deps_tool")]),
    "package.json": JSON.stringify({ name: "deps", dependencies: { "left-pad": "1.0.0" } }),
  }));
  const r = await inspect("fake/deps");
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "has_dependencies");
});

test("refuses a zip with a parent-directory path", async () => {
  setRepo("fake/traversal", SHA(4), await makeZip("fake-traversal-1", manifestOnly("trav-plugin", [tool("trav_tool")]), (z) => {
    z.file("fake-traversal-1/../escape.txt", "nope");
  }));
  const r = await inspect("fake/traversal");
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "bad_archive");
  assert.equal(existsSync(join(tmp, "escape.txt")), false);
});

test("refuses a symbolic link in the zip", async () => {
  setRepo("fake/symlink", SHA(5), await makeZip("fake-symlink-1", manifestOnly("sym-plugin", [tool("sym_tool")]), (z) => {
    z.file("fake-symlink-1/link", "/etc/passwd", { unixPermissions: 0o120777 });
  }));
  const r = await inspect("fake/symlink");
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "bad_archive");
});

test("refuses a plugin whose unpacked size is over 2MB", async () => {
  setRepo("fake/big", SHA(6), await makeZip("fake-big-1", {
    ...manifestOnly("big-plugin", [tool("big_tool")]),
    "data.txt": "a".repeat(3 * 1024 * 1024),
  }));
  const r = await inspect("fake/big");
  assert.equal(r.status, 413);
  assert.equal(r.json.code, "too_large");
});

test("refuses a repo without plugin.json, and an invalid manifest", async () => {
  setRepo("fake/nomanifest", SHA(7), await makeZip("fake-nomanifest-1", { "index.mjs": "export const tools = {};" }));
  const a = await inspect("fake/nomanifest");
  assert.equal(a.status, 400);
  assert.equal(a.json.code, "bad_manifest");
  setRepo("fake/badmanifest", SHA(8), await makeZip("fake-badmanifest-1", {
    "plugin.json": JSON.stringify({ id: "bad-plugin", name: "x", version: "1", description: "d", main: "index.mjs", tools: [{ name: "Bad-Name", description: "d", parameters: {}, permissions: [] }] }),
    "index.mjs": "export const tools = {};",
  }));
  const b = await inspect("fake/badmanifest");
  assert.equal(b.status, 400);
  assert.equal(b.json.code, "bad_manifest");
});

test("refuses an id whose folder was placed by hand (id_conflict)", async () => {
  setRepo("fake/manual", SHA(9), await makeZip("fake-manual-1", manifestOnly("manual-plugin", [tool("manual_other")])));
  const r = await inspect("fake/manual");
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "id_conflict");
});

test("refuses a tool name that a builtin tool already has (tool_conflict)", async () => {
  setRepo("fake/conflict", SHA(10), await makeZip("fake-conflict-1", manifestOnly("conflict-plugin", [tool("web_search")])));
  const r = await inspect("fake/conflict");
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "tool_conflict");
});

test("only github is a source, and other hosts are bad_source", async () => {
  const other = await inspect("https://gitlab.com/owner/name");
  assert.equal(other.status, 400);
  assert.equal(other.json.code, "bad_source");
  const notGithub = await api("POST", "/admin/plugins/inspect", { source: "zip", repo: "fake/hello" });
  assert.equal(notGithub.json.code, "bad_source");
});

test("a repo that does not exist is github_not_found", async () => {
  const r = await inspect("fake/nothing-here");
  assert.equal(r.status, 404);
  assert.equal(r.json.code, "github_not_found");
});

test("the https github.com URL form is accepted", async () => {
  const r = await inspect("https://github.com/fake/hello.git");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.source.repo, "fake/hello");
});

test("inspections expire after the TTL (410 inspection_expired)", async () => {
  const i = await inspect("fake/hello");
  await sleep(TTL_MS + 300);
  const r = await api("POST", "/admin/plugins/install", { inspectionId: i.json.inspectionId, confirmId: "hello-plugin" });
  assert.equal(r.status, 410);
  assert.equal(r.json.code, "inspection_expired");
});

test("non-admins get 403 on every plugin route", async () => {
  const a = await inspect("fake/hello", undefined, undefined, memberTok);
  assert.equal(a.status, 403);
  assert.equal(a.json.code, "forbidden");
  const b = await api("GET", "/admin/plugins", undefined, memberTok);
  assert.equal(b.status, 403);
  const c = await api("PATCH", "/admin/plugins/hello-plugin", { enabled: false }, memberTok);
  assert.equal(c.status, 403);
});

test("a hand-placed plugin is listed as local, always enabled, and not manageable", async () => {
  const row = await pluginRow("manual-plugin");
  assert.equal(row.source, "local");
  assert.equal(row.enabled, true);
  assert.equal(row.tools[0].name, "manual_tool");
  assert.equal(row.tools[0].available, true);
  assert.equal(row.modified, undefined);
  const off = await api("PATCH", "/admin/plugins/manual-plugin", { enabled: false });
  assert.equal(off.status, 409);
  assert.equal(off.json.code, "not_managed");
  const del = await api("DELETE", "/admin/plugins/manual-plugin");
  assert.equal(del.status, 409);
  assert.equal(del.json.code, "not_managed");
  assert.ok(existsSync(join(pluginsDir, "manual-plugin", "plugin.json")), "still on disk");
  const upd = await api("POST", "/admin/plugins/manual-plugin/check-update");
  assert.equal(upd.json.code, "not_managed");
});

test("delete removes the folder, the row and the tool grants", async () => {
  // a grant for one of the plugin's tools, as the approval dialog would create it
  const db = new DatabaseSync(dbPath);
  db.prepare("INSERT OR REPLACE INTO tool_grants (user_id, tool_name, granted_at) VALUES (?, 'hello_tool', ?)").run(adminId, Date.now());
  db.close();
  const d = await api("DELETE", "/admin/plugins/hello-plugin");
  assert.equal(d.status, 200, JSON.stringify(d.json));
  assert.equal(d.json.ok, true);
  assert.equal(existsSync(join(pluginsDir, "hello-plugin")), false);
  assert.equal(await pluginRow("hello-plugin"), undefined);
  const check = new DatabaseSync(dbPath);
  assert.equal((check.prepare("SELECT COUNT(*) AS n FROM tool_grants WHERE tool_name = 'hello_tool'").get() as any).n, 0);
  assert.equal((check.prepare("SELECT COUNT(*) AS n FROM plugin_installs WHERE id = 'hello-plugin'").get() as any).n, 0);
  check.close();
  assert.equal((await toolsList()).some((x) => x.name === "hello_tool"), false);
});

test("a deleted plugin is not found afterwards", async () => {
  const r = await api("PATCH", "/admin/plugins/hello-plugin", { enabled: true });
  assert.equal(r.status, 404);
  assert.equal(r.json.code, "not_found");
});
