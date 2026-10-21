import { readdir, readFile, mkdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DATA_DIR } from "../config.js";
import { db } from "../db.js";
import { getSearchBackend } from "../search/index.js";
import { runSearchPipeline, NO_BACKEND, type SearchRuntime } from "../search/pipeline.js";
import { callIsolated, isolationFor, stopPluginHosts } from "../plugin-sandbox.js";
import {
  TOOL_NAME_RE, TOOL_PERMISSIONS, TOOL_RESULT_CAP,
  type ToolInfo, type ToolManifest, type ToolPermission, type SearchSource, type PluginIsolation,
} from "./types.js";

/* Tool registry: builtin tools + in-process plugins (PROTOCOL-v3-phase3.md section 1).
 * SECURITY: `permissions` are declarations for the approval UI. Plugins installed through the admin flow run in a
 * child process with enforced file/process limits (plugin-sandbox.ts, PLUGIN_ISOLATION); hand-placed plugins run in
 * this process with the server's OS permissions unless PLUGIN_ISOLATION=process-all. Network is NOT enforced for a
 * child (Node 24): only ctx.fetch is proxied. Only install plugins you trust. Managed by files + admin POST /tools/reload. */

export interface ToolCtx {
  /** only present when the tool declares the "network" permission */
  fetch?: typeof fetch;
  signal: AbortSignal;
  log(msg: string): void;
  userId: string;
  config: Record<string, unknown>;
}
/** Per assistant message state shared by the tools of one turn (builtin tools record search sources here). */
export interface TurnState { sources: SearchSource[]; usedBackend?: string; /** search machinery of this answer (limits, models, guard); set by chat.ts */ search?: SearchRuntime }
type Handler = (args: any, ctx: ToolCtx, turn: TurnState) => Promise<string | object | undefined | void> | string | object | undefined | void;

interface Reg {
  manifest: ToolManifest;
  source: "builtin" | "plugin";
  pluginId: string | null;
  handler: Handler | null;
  error?: string;
  /** plugin tools only: where the code runs (plugin-sandbox.ts) */
  isolation?: PluginIsolation;
}

export const pluginsDir = (): string => resolve(process.env.PLUGINS_DIR ?? join(DATA_DIR, "plugins"));
export const toolTimeoutMs = (): number => {
  const n = Number(process.env.TOOL_TIMEOUT_MS ?? 30_000);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
};

/* ---------------- builtin web_search ---------------- */

const WEB_SEARCH: ToolManifest = {
  name: "web_search",
  description: "Search the web. Returns numbered results (title, URL, text from the pages) as untrusted reference data. Write a short keyword query (keep product and model names exact). Cite sources as [n]. The number of searches and sites per answer is limited: search only when needed.",
  parameters: { type: "object", properties: { query: { type: "string", description: "The search query" } }, required: ["query"] },
  permissions: ["network"],
};

/** Runs one search through the pipeline (limits, domain lists, relevance, page reading, injection guard) and returns the text for the model. */
export async function runWebSearch(query: string, signal: AbortSignal | undefined, turn: TurnState): Promise<string> {
  return runSearchPipeline(query, signal, turn);
}

const builtin = new Map<string, Reg>([
  ["web_search", {
    manifest: WEB_SEARCH, source: "builtin", pluginId: null,
    handler: (args, ctx, turn) => runWebSearch(typeof args?.query === "string" ? args.query : "", ctx.signal, turn),
  }],
]);

/* ---------------- plugins ---------------- */

let plugins = new Map<string, Reg>();
let problems: ToolInfo[] = [];
let generation = 0;
let loading: Promise<void> | null = null;

const problem = (pluginId: string, error: string): ToolInfo => ({
  name: pluginId, description: "", parameters: { type: "object", properties: {} }, permissions: [],
  source: "plugin", pluginId, available: false, error, needsApproval: false,
});

/** Validates one manifest tool entry; throws a readable Error. */
export function validateToolManifest(t: any): ToolManifest {
  if (!t || typeof t !== "object") throw new Error("tool entry must be an object");
  if (typeof t.name !== "string" || !TOOL_NAME_RE.test(t.name)) throw new Error(`tool name "${String(t.name)}" must match [a-z0-9_]{1,40}`);
  if (typeof t.description !== "string") throw new Error(`tool ${t.name}: description must be a string`);
  if (!t.parameters || typeof t.parameters !== "object" || Array.isArray(t.parameters)) throw new Error(`tool ${t.name}: parameters must be a JSON Schema object`);
  const perms: unknown = t.permissions ?? [];
  if (!Array.isArray(perms) || perms.some((p) => !TOOL_PERMISSIONS.includes(p as ToolPermission))) {
    throw new Error(`tool ${t.name}: permissions must be a subset of ${TOOL_PERMISSIONS.join(", ")}`);
  }
  return { name: t.name, description: t.description, parameters: t.parameters, permissions: [...new Set(perms as ToolPermission[])] };
}

interface PluginManifest { id: string; name: string; version: string; description: string; main: string; tools: ToolManifest[] }

export function validatePluginManifest(m: any, dirName: string): PluginManifest {
  if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error("plugin.json must be an object");
  if (typeof m.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(m.id)) throw new Error("id must match [a-z0-9][a-z0-9_-]{0,39}");
  if (m.id !== dirName) throw new Error(`id "${m.id}" must equal the directory name "${dirName}"`);
  for (const k of ["name", "version", "description"]) if (typeof m[k] !== "string") throw new Error(`${k} must be a string`);
  if (typeof m.main !== "string" || !/\.(mjs|js)$/.test(m.main) || m.main.includes("..") || /^([a-z]:|[\\/])/i.test(m.main)) {
    throw new Error("main must be a relative .mjs/.js path inside the plugin directory");
  }
  if (!Array.isArray(m.tools) || !m.tools.length) throw new Error("tools must be a non-empty array");
  return { id: m.id, name: m.name, version: m.version, description: m.description, main: m.main, tools: m.tools.map(validateToolManifest) };
}

async function loadOne(dir: string, dirName: string, out: Map<string, Reg>, probs: ToolInfo[], gen: number): Promise<void> {
  let manifest: PluginManifest;
  try {
    let raw: string;
    try { raw = await readFile(join(dir, "plugin.json"), "utf8"); } catch { throw new Error("plugin.json not found"); }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch (e: any) { throw new Error(`plugin.json is not valid JSON: ${e?.message ?? e}`); }
    manifest = validatePluginManifest(parsed, dirName);
    // manifest-level duplicates inside one plugin
    const seen = new Set<string>();
    for (const t of manifest.tools) {
      if (seen.has(t.name)) throw new Error(`duplicate tool name "${t.name}"`);
      seen.add(t.name);
    }
  } catch (e: any) {
    probs.push(problem(dirName, String(e?.message ?? e)));
    return;
  }
  // installed from GitHub and switched off by the administrator: never import it (no code runs)
  const managed = db.prepare("SELECT enabled FROM plugin_installs WHERE id = ?").get(manifest.id) as { enabled: number } | undefined;
  if (managed && !managed.enabled) {
    probs.push(problem(manifest.id, "disabled by the administrator"));
    return;
  }

  const isolation = isolationFor(!!managed);
  if (isolation === "process") {
    // stage 2: the code is imported in a child process on the first call; here only the entry file is checked
    const file = resolve(dir, manifest.main);
    const inside = file.startsWith(resolve(dir) + sep);
    const exists = inside && await stat(file).then((st) => st.isFile(), () => false);
    const loadErr = !inside ? "main must stay inside the plugin directory" : exists ? undefined : `failed to load ${manifest.main}: file not found`;
    for (const t of manifest.tools) {
      if (out.has(t.name) || builtin.has(t.name)) {
        probs.push({ ...t, source: "plugin", pluginId: manifest.id, available: false, error: `tool name "${t.name}" is already provided by ${builtin.has(t.name) ? "a builtin tool" : "another plugin"}`, needsApproval: t.permissions.length > 0, isolation });
        continue;
      }
      const network = t.permissions.includes("network");
      out.set(t.name, {
        manifest: t, source: "plugin", pluginId: manifest.id, isolation, ...(loadErr ? { error: loadErr } : {}),
        handler: loadErr ? null : (args, ctx) => callIsolated({
          pluginId: manifest.id, dir: resolve(dir), main: file, tool: t.name, args, network,
          userId: ctx.userId, signal: ctx.signal, log: ctx.log,
        }),
      });
    }
    return;
  }

  let moduleTools: Record<string, unknown> | null = null;
  let loadError: string | undefined;
  try {
    const file = resolve(dir, manifest.main);
    if (!file.startsWith(resolve(dir) + sep)) throw new Error("main must stay inside the plugin directory");
    // cache-busting query: a reload re-evaluates the module
    const mod: any = await import(`${pathToFileURL(file).href}?v=${gen}`);
    if (!mod || typeof mod.tools !== "object" || !mod.tools) throw new Error("module does not export `tools`");
    moduleTools = mod.tools;
  } catch (e: any) {
    loadError = `failed to load ${manifest.main}: ${String(e?.message ?? e)}`;
  }

  for (const t of manifest.tools) {
    let error = loadError;
    const fn = moduleTools?.[t.name];
    if (!error && typeof fn !== "function") error = `module does not export a function for tool "${t.name}"`;
    if (!error && (builtin.has(t.name) || out.has(t.name))) error = `tool name "${t.name}" is already provided by ${builtin.has(t.name) ? "a builtin tool" : "another plugin"}`;
    if (builtin.has(t.name) || out.has(t.name)) {
      // never replace an existing registration; surface the conflict as a problem entry
      probs.push({ ...t, source: "plugin", pluginId: manifest.id, available: false, error, needsApproval: t.permissions.length > 0 });
      continue;
    }
    out.set(t.name, { manifest: t, source: "plugin", pluginId: manifest.id, isolation, handler: error ? null : (fn as Handler), ...(error ? { error } : {}) });
  }
}

/** Rescans $DATA_DIR/plugins. Errors are isolated per plugin and shown in /tools. */
export function reloadPlugins(): Promise<void> {
  const run = async () => {
    const gen = ++generation;
    // every plugin child is stopped on reload (install, enable/disable, delete, admin reload); the next call restarts it
    stopPluginHosts("reload");
    const out = new Map<string, Reg>();
    const probs: ToolInfo[] = [];
    const root = pluginsDir();
    try { await mkdir(root, { recursive: true }); } catch { /* ignore */ }
    let entries: string[] = [];
    try {
      entries = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name).sort();
    } catch { /* no plugins dir */ }
    for (const name of entries) {
      try { await loadOne(join(root, name), name, out, probs, gen); }
      catch (e: any) { probs.push(problem(name, String(e?.message ?? e))); }
    }
    plugins = out;
    problems = probs;
  };
  // serialise concurrent reloads
  loading = (loading ?? Promise.resolve()).then(run, run);
  return loading;
}

/** Waits for the first load (started by registerToolRoutes) and any reload in flight. */
export async function toolsReady(): Promise<void> {
  if (!loading) await reloadPlugins();
  else await loading;
}

/* ---------------- lookup ---------------- */

function info(r: Reg): ToolInfo {
  let available = !r.error && !!r.handler;
  let error = r.error;
  if (r.source === "builtin" && r.manifest.name === "web_search" && !getSearchBackend()) {
    available = false;
    error = NO_BACKEND;
  }
  return {
    ...r.manifest, source: r.source, pluginId: r.pluginId, available, ...(error ? { error } : {}),
    needsApproval: r.manifest.permissions.length > 0,
    ...(r.isolation ? { isolation: r.isolation } : {}),
  };
}

export function listTools(): ToolInfo[] {
  return [...[...builtin.values()].map(info), ...[...plugins.values()].map(info), ...problems];
}

export function getTool(name: string): ToolInfo | undefined {
  const r = builtin.get(name) ?? plugins.get(name);
  return r ? info(r) : undefined;
}

/* ---------------- execution ---------------- */

const MARK = "\n…[truncated]";
export function truncateResult(s: string, cap = TOOL_RESULT_CAP): string {
  if (Buffer.byteLength(s, "utf8") <= cap) return s;
  const keep = Buffer.from(s, "utf8").subarray(0, cap - Buffer.byteLength(MARK, "utf8")).toString("utf8").replace(/�+$/, "");
  return keep + MARK;
}

export interface RunOpts { userId: string; signal: AbortSignal; turn: TurnState; timeoutMs?: number }

/** Executes a tool with a timeout; returns the (truncated) result text. Throws Error on failure / timeout / abort. */
export async function runTool(name: string, args: unknown, o: RunOpts): Promise<string> {
  const r = builtin.get(name) ?? plugins.get(name);
  if (!r) throw new Error(`unknown tool "${name}"`);
  const i = info(r);
  if (!i.available || !r.handler) throw new Error(i.error ?? "tool unavailable");
  const timeout = o.timeoutMs ?? toolTimeoutMs();
  const ac = new AbortController();
  const onAbort = () => ac.abort(o.signal.reason);
  if (o.signal.aborted) throw new Error("stopped");
  o.signal.addEventListener("abort", onAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const ctx: ToolCtx = {
    signal: ac.signal,
    log: (m) => console.log(`[tool:${name}] ${String(m).slice(0, 500)}`),
    userId: o.userId,
    config: {},
    ...(r.manifest.permissions.includes("network") ? { fetch: ((u: any, init?: any) => fetch(u, { signal: ac.signal, ...init })) as typeof fetch } : {}),
  };
  try {
    const out = await Promise.race([
      Promise.resolve().then(() => r.handler!(args, ctx, o.turn)),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => { const e = new Error(`timed out after ${timeout} ms`); ac.abort(e); rej(e); }, timeout);
        ac.signal.addEventListener("abort", () => rej(o.signal.aborted ? new Error("stopped") : (ac.signal.reason instanceof Error ? ac.signal.reason : new Error("aborted"))), { once: true });
      }),
    ]);
    const text = typeof out === "string" ? out : out === undefined || out === null ? "" : JSON.stringify(out);
    return truncateResult(text);
  } finally {
    clearTimeout(timer);
    o.signal.removeEventListener("abort", onAbort);
  }
}
