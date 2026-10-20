import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import JSZip from "jszip";
import { db } from "./db.js";
import { actorOf, recordAudit } from "./admin-core.js";
import { listTools, pluginsDir, reloadPlugins, validatePluginManifest } from "./tools/registry.js";
import { scanPlugin, summarizeFindings, type ScanResult } from "./plugin-scan.js";

/* Plugin install from GitHub (docs/PROTOCOL-v7-plugins.md, docs/design/PLUGIN-INSTALL.md).
 * Admin only (the routes check that). The zip is inspected in memory; nothing is written until install. */

export const LIMITS = { zipBytes: 5 * 1024 * 1024, unpackedBytes: 2 * 1024 * 1024, files: 200 } as const;
const FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DISABLED_NOTE = "disabled by the administrator";

/** An error with the contract's machine-readable code and an HTTP status. */
export class PluginError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

type Manifest = ReturnType<typeof validatePluginManifest>;

export interface FileEntry { path: string; size: number; sha256: string }
export interface Inspection {
  id: string;
  userId: string;
  expiresAt: number;
  used: boolean;
  repo: string;
  ref: string | null;
  subdir: string;
  commitSha: string;
  manifest: Manifest;
  files: FileEntry[];
  contents: Map<string, Buffer>;
  totalBytes: number;
  scan: ScanResult;
  warnings: string[];
  alreadyInstalled: boolean;
  installedCommitSha?: string;
}

export interface PluginRowOut {
  id: string; name: string; version: string; description: string;
  source: "github" | "local"; repo?: string; ref?: string; commitSha?: string;
  enabled: boolean; installedAt?: number; updatedAt?: number;
  tools: { name: string; permissions: string[]; available: boolean; error?: string }[];
  scan?: { high: number; medium: number; info: number };
  modified?: boolean;
}

interface PluginInstallRow {
  id: string; source: string; repo: string | null; ref: string | null; subdir: string | null; commit_sha: string | null;
  version: string | null; files_sha256: string; scan_json: string; installed_by: string; installed_at: number; updated_at: number; enabled: number;
}

const inspections = new Map<string, Inspection>();
const ttlMs = (): number => {
  const n = Number(process.env.OMNICHAT_PLUGIN_INSPECTION_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
};
const githubApi = (): string => (process.env.OMNICHAT_GITHUB_API || "https://api.github.com").replace(/\/+$/, "");
const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const errMsg = (e: unknown): string => (e as any)?.message ?? String(e);

/* ---------------- input parsing ---------------- */

const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;

/** `owner/name` or `https://github.com/owner/name` (optional .git and trailing slash). Other hosts: bad_source. */
export function parseRepo(input: unknown): string {
  if (typeof input !== "string") throw new PluginError("bad_source", "repo は owner/name の文字列です", 400);
  let s = input.trim();
  const m = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(s);
  if (m) s = `${m[1]}/${m[2]}`;
  else if (s.includes("://") || s.includes("@") || s.includes(":")) throw new PluginError("bad_source", "GitHub 以外のホストは導入できません", 400);
  s = s.replace(/\/+$/, "").replace(/\.git$/, "");
  const parts = s.split("/");
  if (parts.length !== 2) throw new PluginError("bad_source", "repo は owner/name の形で指定してください", 400);
  const [owner, name] = parts;
  if (!NAME_RE.test(owner) || !NAME_RE.test(name) || /^\.+$/.test(owner) || /^\.+$/.test(name)) {
    throw new PluginError("bad_source", "repo の名前が不正です", 400);
  }
  return `${owner}/${name}`;
}

function parseRef(input: unknown): string | null {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input !== "string" || input.length > 200 || !/^[A-Za-z0-9._/-]+$/.test(input) || input.startsWith("-")
    || input.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    throw new PluginError("bad_source", "ref が不正です", 400);
  }
  return input;
}

function parseSubdir(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input !== "string") throw new PluginError("bad_source", "subdir が不正です", 400);
  const s = input.replace(/^\/+|\/+$/g, "");
  if (!s) return "";
  if (s.split("/").some((seg) => !/^[A-Za-z0-9._-]+$/.test(seg) || seg === "." || seg === "..")) {
    throw new PluginError("bad_source", "subdir が不正です", 400);
  }
  return s;
}

const refPath = (ref: string): string => ref.split("/").map(encodeURIComponent).join("/");

/* ---------------- GitHub ---------------- */

async function ghGet(path: string): Promise<Response> {
  let r: Response;
  try {
    r = await fetch(githubApi() + path, {
      headers: { accept: "application/vnd.github+json", "user-agent": "omnichat-plugin-installer", "x-github-api-version": "2022-11-28" },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    throw new PluginError("download_failed", `GitHub に接続できません: ${errMsg(e)}`, 502);
  }
  if (r.status === 404) throw new PluginError("github_not_found", "リポジトリまたは ref が見つかりません", 404);
  if (r.status === 429 || (r.status === 403 && r.headers.get("x-ratelimit-remaining") === "0")) {
    throw new PluginError("github_rate_limited", "GitHub の利用制限に達しました。しばらく待ってから再度お試しください", 429);
  }
  if (!r.ok) throw new PluginError("download_failed", `GitHub が ${r.status} を返しました`, 502);
  return r;
}

async function readLimited(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try { chunk = await reader.read(); } catch (e) { throw new PluginError("download_failed", `ダウンロードに失敗しました: ${errMsg(e)}`, 502); }
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new PluginError("too_large", "zip が大きすぎます（上限 5MB）", 413);
    }
    chunks.push(Buffer.from(chunk.value));
  }
  return Buffer.concat(chunks, total);
}

async function downloadZip(repo: string, ref: string | null): Promise<Buffer> {
  const r = await ghGet(`/repos/${repo}/zipball${ref ? "/" + refPath(ref) : ""}`);
  const declared = Number(r.headers.get("content-length") ?? 0);
  if (declared > LIMITS.zipBytes) { await r.body?.cancel().catch(() => {}); throw new PluginError("too_large", "zip が大きすぎます（上限 5MB）", 413); }
  return readLimited(r.body, LIMITS.zipBytes);
}

async function resolveCommit(repo: string, ref: string | null): Promise<string> {
  const r = await ghGet(`/repos/${repo}/commits/${ref ? refPath(ref) : "HEAD"}`);
  const j = (await r.json().catch(() => null)) as any;
  const sha = typeof j?.sha === "string" ? j.sha : "";
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new PluginError("download_failed", "コミットを確定できませんでした", 502);
  return sha;
}

/* ---------------- zip ---------------- */

const SKIP_SEGMENTS = new Set([".git", "node_modules"]);

/** Refuses absolute paths, drive letters, backslashes, NULs and `..` segments (bad_archive). */
function checkEntryName(raw: string): void {
  const bad = () => new PluginError("bad_archive", `zip の中のパスが不正です: ${JSON.stringify(raw).slice(0, 120)}`, 400);
  if (raw.includes("\\") || raw.includes("\0") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw bad();
  if (raw.split("/").some((seg) => seg === "..")) throw bad();
}

/** Reads the zip in memory. Returns the files under `subdir` of the GitHub root folder, with paths relative to the plugin. */
export async function extractZip(zipBuf: Buffer, subdir: string): Promise<{ files: FileEntry[]; contents: Map<string, Buffer>; totalBytes: number }> {
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(zipBuf); } catch { throw new PluginError("bad_archive", "zip を開けません", 400); }
  const entries = Object.values(zip.files);
  const names = entries.map((e) => e.name);
  for (const e of entries) {
    checkEntryName(e.name);
    const mode = (e as any).unixPermissions;
    if (typeof mode === "number" && (mode & 0o170000) === 0o120000) {
      throw new PluginError("bad_archive", `シンボリックリンクは導入できません: ${e.name.slice(0, 120)}`, 400);
    }
  }
  // GitHub zipballs wrap everything in one folder ("owner-repo-sha/")
  const tops = new Set(names.map((n) => n.split("/")[0]));
  const root = tops.size === 1 && names.some((n) => n.includes("/")) ? [...tops][0] + "/" : "";
  const prefix = subdir ? subdir + "/" : "";

  const files: FileEntry[] = [];
  const contents = new Map<string, Buffer>();
  let totalBytes = 0;
  let declaredTotal = 0;
  for (const e of entries) {
    if (e.dir) continue;
    if (!e.name.startsWith(root)) continue;
    let rel = e.name.slice(root.length);
    if (!rel.startsWith(prefix)) continue;
    rel = rel.slice(prefix.length);
    if (!rel || rel.split("/").some((seg) => SKIP_SEGMENTS.has(seg))) continue;
    if (contents.has(rel)) throw new PluginError("bad_archive", `同じパスが重複しています: ${rel.slice(0, 120)}`, 400);
    if (files.length + 1 > LIMITS.files) throw new PluginError("too_large", "ファイル数が多すぎます（上限 200 個）", 413);
    const declared = (e as any)._data?.uncompressedSize;
    if (typeof declared === "number") {
      declaredTotal += declared;
      if (declaredTotal > LIMITS.unpackedBytes) throw new PluginError("too_large", "展開後のサイズが大きすぎます（上限 2MB）", 413);
    }
    const data = Buffer.from(await e.async("uint8array"));
    totalBytes += data.length;
    if (totalBytes > LIMITS.unpackedBytes) throw new PluginError("too_large", "展開後のサイズが大きすぎます（上限 2MB）", 413);
    contents.set(rel, data);
    files.push({ path: rel, size: data.length, sha256: sha256(data) });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, contents, totalBytes };
}

/* ---------------- conflicts / local state ---------------- */

function getRow(id: string): PluginInstallRow | undefined {
  return db.prepare("SELECT * FROM plugin_installs WHERE id = ?").get(id) as PluginInstallRow | undefined;
}

const dirOf = (id: string): string => join(pluginsDir(), id);

async function isDir(p: string): Promise<boolean> {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

/** Disk hashes of every file in a plugin folder, or null when the folder is missing. Non-regular entries hash to a marker. */
async function hashFolder(dir: string): Promise<Record<string, string> | null> {
  if (!(await isDir(dir))) return null;
  const out: Record<string, string> = {};
  const walk = async (abs: string, rel: string): Promise<void> => {
    for (const d of await readdir(abs, { withFileTypes: true })) {
      const a = join(abs, d.name);
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) await walk(a, r);
      else if (d.isFile()) out[r] = sha256(await readFile(a));
      else out[r] = "!not-a-regular-file";
    }
  };
  await walk(dir, "");
  return out;
}

/** True when the disk differs from the hashes recorded at install time (or the folder is gone). */
async function modifiedFor(row: PluginInstallRow): Promise<boolean> {
  const disk = await hashFolder(dirOf(row.id));
  if (!disk) return true;
  const recorded = JSON.parse(row.files_sha256) as Record<string, string>;
  const a = Object.keys(recorded).sort();
  const b = Object.keys(disk).sort();
  return a.length !== b.length || a.some((k, i) => k !== b[i] || recorded[k] !== disk[k]);
}

/** The manifest of the plugin folder on disk (null when missing or invalid). */
async function installedManifest(id: string): Promise<Manifest | null> {
  try {
    const raw = JSON.parse(await readFile(join(dirOf(id), "plugin.json"), "utf8"));
    return validatePluginManifest(raw, id);
  } catch { return null; }
}

/** id_conflict: an id folder that this mechanism did not install. tool_conflict: a builtin or another plugin already has a tool name. */
async function checkConflicts(m: Manifest, row: PluginInstallRow | undefined): Promise<void> {
  if (!row && (await isDir(dirOf(m.id)))) {
    throw new PluginError("id_conflict", `id "${m.id}" のフォルダが既にあります（手で置いたプラグインです）`, 409);
  }
  const current = listTools();
  for (const t of m.tools) {
    const clash = current.find((x) => x.name === t.name && x.pluginId !== m.id);
    if (clash) throw new PluginError("tool_conflict", `ツール名 "${t.name}" は ${clash.source === "builtin" ? "組み込みツール" : "別のプラグイン"} と重複しています`, 409);
  }
}

/* ---------------- inspect ---------------- */

function dependencyRefusal(files: Map<string, Buffer>, main: string): string | null {
  const pkg = files.get("package.json");
  if (pkg) {
    let j: any;
    try { j = JSON.parse(pkg.toString("utf8")); } catch { throw new PluginError("bad_manifest", "package.json が正しい JSON ではありません", 400); }
    for (const k of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      if (j && typeof j[k] === "object" && j[k] && Object.keys(j[k]).length > 0) return `package.json に ${k} があります（依存パッケージは導入できません）`;
    }
  }
  if (posix.normalize(main).split("/").includes("node_modules")) return "main が node_modules を指しています（依存パッケージは導入できません）";
  return null;
}

/** Downloads, extracts and checks one plugin source. Stores nothing. `updateOf` = the installed id being updated. */
export async function fetchInspection(o: { repo: string; ref: string | null; subdir: string; userId: string; updateOf?: string }): Promise<Inspection> {
  // resolve first and download that exact commit: a branch that moves in between must not pair another commit's sha with this content
  const commitSha = await resolveCommit(o.repo, o.ref);
  const zipBuf = await downloadZip(o.repo, commitSha);
  const ex = await extractZip(zipBuf, o.subdir);

  const pj = ex.contents.get("plugin.json");
  if (!pj) throw new PluginError("bad_manifest", "plugin.json が見つかりません", 400);
  let parsed: any;
  try { parsed = JSON.parse(pj.toString("utf8")); } catch (e) { throw new PluginError("bad_manifest", `plugin.json が正しい JSON ではありません: ${errMsg(e)}`, 400); }
  let manifest: Manifest;
  try {
    if (!parsed || typeof parsed !== "object" || typeof parsed.id !== "string") throw new Error("id must be a string");
    manifest = validatePluginManifest(parsed, parsed.id);
    const seen = new Set<string>();
    for (const t of manifest.tools) {
      if (seen.has(t.name)) throw new Error(`duplicate tool name "${t.name}"`);
      seen.add(t.name);
    }
  } catch (e) {
    throw new PluginError("bad_manifest", `plugin.json が不正です: ${errMsg(e)}`, 400);
  }
  if (o.updateOf && manifest.id !== o.updateOf) throw new PluginError("bad_manifest", `id が変わっています（${o.updateOf} → ${manifest.id}）`, 400);
  const main = posix.normalize(manifest.main);
  if (main.startsWith("../") || !ex.contents.has(main)) throw new PluginError("bad_manifest", `main "${manifest.main}" が見つかりません`, 400);
  const depReason = dependencyRefusal(ex.contents, manifest.main);
  if (depReason) throw new PluginError("has_dependencies", depReason, 400);

  const row = getRow(manifest.id);
  await checkConflicts(manifest, row);

  const scan = scanPlugin({
    files: ex.files.filter((f) => /\.(?:mjs|cjs|js|mts|cts|ts)$/i.test(f.path)).map((f) => ({ path: f.path, text: ex.contents.get(f.path)!.toString("utf8") })),
    tools: manifest.tools,
  });
  const high = scan.findings.filter((f) => f.severity === "high").length;

  const warnings: string[] = [
    "導入するプラグインのコードは、サーバーと同じ権限で動きます（サンドボックスはありません）。",
  ];
  if (!row) warnings.push("導入直後は無効です。有効にするまで、コードは一度も実行されません。");
  if (row) {
    warnings.push(`導入済みのプラグインを更新します（導入済みのコミット: ${String(row.commit_sha ?? "").slice(0, 7)}）。有効 / 無効の状態は保たれます。`);
    if (row.repo !== o.repo) warnings.push(`導入済みのプラグインは別のリポジトリ（${row.repo ?? "不明"}）からのものです。`);
    if (await modifiedFor(row)) warnings.push("ディスク上のファイルが導入後に書き換わっています。更新で上書きされます。");
  }
  if (high > 0) warnings.push(`危険の可能性がある箇所が ${high} 件あります（重大度: 高）。内容を確認してから導入してください。`);
  if (scan.permissionMismatch.length) warnings.push("宣言された権限と、コードが使っている内容が一致しません。");

  return {
    id: randomUUID(), userId: o.userId, expiresAt: Date.now() + ttlMs(), used: false,
    repo: o.repo, ref: o.ref, subdir: o.subdir, commitSha, manifest,
    files: ex.files, contents: ex.contents, totalBytes: ex.totalBytes, scan, warnings,
    alreadyInstalled: !!row, ...(row ? { installedCommitSha: row.commit_sha ?? undefined } : {}),
  };
}

function sweepInspections(): void {
  const now = Date.now();
  for (const [k, v] of inspections) if (v.expiresAt <= now || v.used) inspections.delete(k);
}

export function storeInspection(insp: Inspection): void {
  sweepInspections();
  inspections.set(insp.id, insp);
}

/** The response of POST /admin/plugins/inspect (and the update part of check-update). */
export function inspectionResponse(insp: Inspection): Record<string, unknown> {
  const m = insp.manifest;
  return {
    inspectionId: insp.id,
    source: { repo: insp.repo, ref: insp.ref, subdir: insp.subdir, commitSha: insp.commitSha },
    manifest: {
      id: m.id, name: m.name, version: m.version, description: m.description, main: m.main,
      tools: m.tools.map((t) => ({ name: t.name, description: t.description, permissions: t.permissions })),
    },
    alreadyInstalled: insp.alreadyInstalled,
    ...(insp.installedCommitSha ? { installedCommitSha: insp.installedCommitSha } : {}),
    files: insp.files,
    totalBytes: insp.totalBytes,
    scan: insp.scan,
    warnings: insp.warnings,
  };
}

/** A fresh inspection of a GitHub source; stored under its id until install (single use, 15 min). */
export async function inspectGithub(userId: string, body: { repo?: unknown; ref?: unknown; subdir?: unknown }): Promise<Inspection> {
  const insp = await fetchInspection({ repo: parseRepo(body.repo), ref: parseRef(body.ref), subdir: parseSubdir(body.subdir), userId });
  storeInspection(insp);
  return insp;
}

/* ---------------- install ---------------- */

async function writeFolder(id: string, insp: Inspection): Promise<void> {
  const root = pluginsDir();
  await mkdir(root, { recursive: true });
  const rnd = randomBytes(6).toString("hex");
  // dot-prefixed staging / backup folders are ignored by the loader
  const staging = join(root, `.staging-${id}-${rnd}`);
  const target = dirOf(id);
  try {
    for (const f of insp.files) {
      const dest = join(staging, ...f.path.split("/"));
      if (!dest.startsWith(staging)) throw new Error("path escapes the staging folder");
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, insp.contents.get(f.path)!);
    }
    // verify the staged files before touching the target: a failure afterwards would leave unreviewed files in the plugin folder
    const staged = await hashFolder(staging);
    const want = Object.fromEntries(insp.files.map((f) => [f.path, f.sha256]));
    if (!staged || Object.keys(staged).length !== Object.keys(want).length || Object.keys(want).some((k) => staged[k] !== want[k])) {
      throw new PluginError("inspection_mismatch", "書き込み後のファイルが検査結果と一致しません", 500);
    }
    let backup: string | null = null;
    if (await isDir(target)) {
      backup = join(root, `.backup-${id}-${rnd}`);
      await rename(target, backup);
    }
    try {
      await rename(staging, target);
    } catch (e) {
      if (backup) await rename(backup, target).catch(() => {});
      throw e;
    }
    if (backup) await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

export async function installInspection(userId: string, inspectionId: string, confirmId: string): Promise<PluginRowOut> {
  sweepInspections();
  const insp = inspections.get(inspectionId);
  if (!insp || insp.userId !== userId || insp.used || insp.expiresAt <= Date.now()) {
    throw new PluginError("inspection_expired", "検査の結果が失効しています。もう一度検査してください", 410);
  }
  if (confirmId !== insp.manifest.id) throw new PluginError("confirm_mismatch", "確認の id がプラグインの id と一致しません", 400);
  const id = insp.manifest.id;
  const row = getRow(id);
  // single use: claimed before the first await, so parallel requests with the same inspection id cannot both install it
  insp.used = true;
  inspections.delete(inspectionId);
  try {
    await checkConflicts(insp.manifest, row);
    for (const f of insp.files) {
      const b = insp.contents.get(f.path);
      if (!b || sha256(b) !== f.sha256) throw new PluginError("inspection_mismatch", "検査した内容と一致しません", 409);
    }
  } catch (e) {
    insp.used = false;
    inspections.set(inspectionId, insp);
    throw e;
  }
  const now = Date.now();
  const filesSha = Object.fromEntries(insp.files.map((f) => [f.path, f.sha256]));
  const upsert = () => db.prepare(`INSERT INTO plugin_installs (id, source, repo, ref, subdir, commit_sha, version, files_sha256, scan_json, installed_by, installed_at, updated_at, enabled)
    VALUES (?, 'github', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET source = excluded.source, repo = excluded.repo, ref = excluded.ref, subdir = excluded.subdir,
      commit_sha = excluded.commit_sha, version = excluded.version, files_sha256 = excluded.files_sha256, scan_json = excluded.scan_json,
      installed_by = excluded.installed_by, updated_at = excluded.updated_at`)
    .run(id, insp.repo, insp.ref, insp.subdir, insp.commitSha, insp.manifest.version, JSON.stringify(filesSha), JSON.stringify(insp.scan), userId, now, now);
  // a new plugin gets its (disabled) row before its folder exists: a reload in between must not see a folder without a row,
  // which the loader treats as a hand-placed plugin and runs
  if (!row) upsert();
  const oldTools = new Map(((row && (await installedManifest(id)))?.tools ?? []).map((t) => [t.name, t]));
  try {
    await writeFolder(id, insp);
  } catch (e) {
    if (!row) db.prepare("DELETE FROM plugin_installs WHERE id = ?").run(id);
    throw e;
  }
  if (row) upsert();
  // a saved approval belongs to the code that was reviewed: a new tool name (it may have been another plugin's) or a tool
  // that gained a permission must be approved again
  for (const t of insp.manifest.tools) {
    const old = oldTools.get(t.name);
    if (!old || t.permissions.some((p) => !old.permissions.includes(p))) revokeToolApprovals(t.name);
  }
  await reloadPlugins();
  recordAudit(actorOf(userId), row ? "plugin.update" : "plugin.install", id,
    row ? { commit: row.commit_sha, version: row.version } : undefined,
    { repo: insp.repo, ref: insp.ref, commit: insp.commitSha, version: insp.manifest.version, enabled: row ? !!row.enabled : false });
  return (await rowFor(id))!;
}

/* ---------------- list / rows ---------------- */

async function rowFor(id: string): Promise<PluginRowOut | undefined> {
  const row = getRow(id);
  const m = await installedManifest(id);
  if (!row && !m) return undefined;
  const statuses = listTools().filter((t) => t.pluginId === id);
  const whole = statuses.find((s) => s.name === id && !s.available);
  const disabled = !!row && !row.enabled;
  const tools = (m?.tools ?? []).map((t) => {
    if (disabled) return { name: t.name, permissions: t.permissions, available: false, error: DISABLED_NOTE };
    const s = statuses.find((x) => x.name === t.name);
    const available = !!s?.available;
    const error = available ? undefined : (s?.error ?? whole?.error ?? "not loaded");
    return { name: t.name, permissions: t.permissions, available, ...(error ? { error } : {}) };
  });
  const out: PluginRowOut = {
    id, name: m?.name ?? id, version: m?.version ?? row?.version ?? "", description: m?.description ?? "",
    source: row ? "github" : "local", enabled: row ? !!row.enabled : true, tools,
  };
  if (row) {
    out.repo = row.repo ?? undefined;
    if (row.ref) out.ref = row.ref;
    out.commitSha = row.commit_sha ?? undefined;
    out.installedAt = row.installed_at;
    out.updatedAt = row.updated_at;
    out.scan = summarizeFindings((JSON.parse(row.scan_json) as ScanResult).findings);
    out.modified = await modifiedFor(row);
  }
  return out;
}

export async function listPlugins(): Promise<PluginRowOut[]> {
  const rows = db.prepare("SELECT id FROM plugin_installs ORDER BY id").all() as { id: string }[];
  let names: string[] = [];
  try {
    names = (await readdir(pluginsDir(), { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name);
  } catch { /* no folder yet */ }
  const ids = [...new Set([...rows.map((r) => r.id), ...names])].sort();
  const out: PluginRowOut[] = [];
  for (const id of ids) {
    const r = await rowFor(id);
    if (r) out.push(r);
  }
  return out;
}

/* ---------------- enable / delete / update ---------------- */

export async function setEnabled(userId: string, id: string, enabled: boolean): Promise<PluginRowOut> {
  const row = getRow(id);
  if (!row) {
    if (await isDir(dirOf(id))) throw new PluginError("not_managed", "手で置いたプラグインは、この画面では有効 / 無効を切り替えられません", 409);
    throw new PluginError("not_found", "プラグインが見つかりません", 404);
  }
  if (!!row.enabled === enabled) return (await rowFor(id))!;
  db.prepare("UPDATE plugin_installs SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, Date.now(), id);
  await reloadPlugins();
  recordAudit(actorOf(userId), enabled ? "plugin.enable" : "plugin.disable", id, { enabled: !!row.enabled }, { enabled });
  return (await rowFor(id))!;
}

/** Removes every user's saved approval of a tool: the tool_grants row and the "always allow" rule that the approval dialog creates. */
function revokeToolApprovals(name: string): void {
  db.prepare("DELETE FROM tool_grants WHERE tool_name = ?").run(name);
  // the "always allow" rules that the approval dialog creates for a tool (same rule as deleteGrant)
  db.prepare("DELETE FROM approval_rules WHERE project_id IS NULL AND kind = 'tool' AND pattern = ? AND action = 'allow' AND note = 'always allow'").run(name);
}

export async function deletePlugin(userId: string, id: string): Promise<void> {
  const row = getRow(id);
  if (!row) {
    if (await isDir(dirOf(id))) throw new PluginError("not_managed", "手で置いたプラグインは削除できません（フォルダを直接消してください）", 409);
    throw new PluginError("not_found", "プラグインが見つかりません", 404);
  }
  const names = new Set<string>([
    ...((await installedManifest(id))?.tools ?? []).map((t) => t.name),
    ...listTools().filter((t) => t.pluginId === id).map((t) => t.name),
  ]);
  await rm(dirOf(id), { recursive: true, force: true });
  db.prepare("DELETE FROM plugin_installs WHERE id = ?").run(id);
  for (const name of names) revokeToolApprovals(name);
  await reloadPlugins();
  recordAudit(actorOf(userId), "plugin.delete", id, { repo: row.repo, commit: row.commit_sha, tools: [...names] }, undefined);
}

export interface UpdateCheck {
  updateAvailable: boolean;
  latestCommitSha: string;
  inspection?: Inspection;
  diff?: {
    added: string[]; removed: string[]; changed: string[]; toolsAdded: string[]; toolsRemoved: string[];
    permissionsAdded: { tool: string; permission: string }[];
  };
}

/** Fetches the newest commit of the installed source (same repo / ref / subdir). Stores the inspection only when an update exists. */
export async function checkUpdate(userId: string, id: string): Promise<UpdateCheck> {
  const row = getRow(id);
  if (!row) {
    if (await isDir(dirOf(id))) throw new PluginError("not_managed", "手で置いたプラグインは更新できません", 409);
    throw new PluginError("not_found", "プラグインが見つかりません", 404);
  }
  const latest = await fetchInspection({ repo: row.repo!, ref: row.ref, subdir: row.subdir ?? "", userId, updateOf: id });
  if (latest.commitSha === row.commit_sha) return { updateAvailable: false, latestCommitSha: latest.commitSha };
  storeInspection(latest);
  const oldFiles = JSON.parse(row.files_sha256) as Record<string, string>;
  const newFiles = Object.fromEntries(latest.files.map((f) => [f.path, f.sha256]));
  const added = Object.keys(newFiles).filter((k) => !(k in oldFiles)).sort();
  const removed = Object.keys(oldFiles).filter((k) => !(k in newFiles)).sort();
  const changed = Object.keys(newFiles).filter((k) => k in oldFiles && oldFiles[k] !== newFiles[k]).sort();
  const oldTools = new Map((((await installedManifest(id))?.tools) ?? []).map((t) => [t.name, t]));
  const permissionsAdded: { tool: string; permission: string }[] = [];
  for (const t of latest.manifest.tools) {
    const before = oldTools.get(t.name)?.permissions ?? [];
    for (const p of t.permissions) if (!before.includes(p)) permissionsAdded.push({ tool: t.name, permission: p });
  }
  const newNames = new Set(latest.manifest.tools.map((t) => t.name));
  return {
    updateAvailable: true,
    latestCommitSha: latest.commitSha,
    inspection: latest,
    diff: {
      added, removed, changed,
      toolsAdded: [...newNames].filter((k) => !oldTools.has(k)),
      toolsRemoved: [...oldTools.keys()].filter((k) => !newNames.has(k)),
      permissionsAdded,
    },
  };
}
