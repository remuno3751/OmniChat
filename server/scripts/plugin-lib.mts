// Plugin authoring helpers (docs/PLUGINS.md "自作の手順"). Used by plugin-new.mts, plugin-check.mts and plugin-cli.test.ts.
// Validation reuses the server's own rules (validatePluginManifest / validateToolManifest) so the check never disagrees with the loader.
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { validatePluginManifest } from "../src/tools/registry.js";
import { scanPlugin, isScannedFile, summarizeFindings } from "../src/plugin-scan.js";

export const MAX_PLUGIN_BYTES = 2 * 1024 * 1024;
export const MAX_PLUGIN_FILES = 200;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const RUN_TIMEOUT_MS = 10_000;

export interface CheckResult {
  dir: string;
  id?: string;
  tools: string[];
  errors: string[];   // failures: exit code 1
  warnings: string[]; // reported only
  info: string[];
}

/** Creates <outParent>/<id>/ with plugin.json, index.mjs and README.md. Refuses to overwrite an existing folder. */
export async function scaffoldPlugin(id: string, outParent: string): Promise<string> {
  if (!ID_RE.test(id)) throw new Error(`id "${id}" must match [a-z0-9][a-z0-9_-]{0,39}`);
  const dir = resolve(outParent, id);
  if (existsSync(dir)) throw new Error(`refusing to overwrite existing folder: ${dir}`);

  // tool names must match [a-z0-9_]{1,40}; keep the "_hello" suffix and cut the base if the id is long
  const base = id.replace(/-/g, "_").slice(0, 34);
  const toolName = `${base}_hello`;
  const title = id.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

  const manifest = {
    id,
    name: title,
    version: "0.1.0",
    description: `${title} (OmniChat plugin). Replace this description with what the plugin does.`,
    main: "index.mjs",
    tools: [
      {
        name: toolName,
        description: "Say hello to someone. Use it when the user asks for a greeting from this plugin.",
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "Optional name to greet (at most 100 characters)." } },
        },
        permissions: [],
      },
    ],
  };

  const index = `// OmniChat plugin "${id}". Runs IN-PROCESS with the server's OS permissions. Only load code you trust.
export const tools = {
  async ${toolName}(args, ctx) {
    // Arguments come from the model: check type and range before using them.
    const name = args?.name;
    if (name !== undefined && (typeof name !== "string" || name.length > 100)) {
      throw new Error("name must be a string of at most 100 characters");
    }
    const who = name?.trim() || "world";
    ctx.log(\`hello \${who}\`);
    return { message: \`Hello, \${who}!\` };
  },
};
`;

  const readme = `# ${title}

OmniChat のツールプラグインです。雛形は \`npm run plugin:new\` で作りました。

## ファイル

- \`plugin.json\`: マニフェスト。\`id\` はフォルダ名と一致させます。
- \`index.mjs\`: ツールの実装。\`tools\` のキーは \`plugin.json\` の \`tools[].name\` と一致させます。

## 検査

\`\`\`bash
cd server
npm run plugin:check -- <このフォルダのパス>
\`\`\`

## 導入

\`$DATA_DIR/plugins/${id}/\` にフォルダごとコピーし、\`POST /tools/reload\` を呼ぶかサーバーを再起動します。

## 注意

プラグインはサーバーの OS 権限で動きます。\`permissions\` は承認画面のための宣言で、サンドボックスではありません。
`;

  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await writeFile(join(dir, "index.mjs"), index, "utf8");
  await writeFile(join(dir, "README.md"), readme, "utf8");
  return dir;
}

async function listFiles(dir: string): Promise<{ count: number; bytes: number }> {
  let count = 0, bytes = 0;
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      const sub = await listFiles(p);
      count += sub.count; bytes += sub.bytes;
    } else if (ent.isFile()) {
      count++; bytes += (await stat(p)).size;
    }
  }
  return { count, bytes };
}

/**
 * Checks a plugin folder. Failures go to `errors` (exit 1); runtime problems of a tool go to `warnings`.
 * `runTools: false` skips executing the tools (they may have side effects).
 */
export async function checkPlugin(inputDir: string, opts: { runTools?: boolean } = {}): Promise<CheckResult> {
  const dir = resolve(inputDir);
  const res: CheckResult = { dir, tools: [], errors: [], warnings: [], info: [] };
  const dirName = basename(dir);

  // 1. manifest
  let manifest: ReturnType<typeof validatePluginManifest> | undefined;
  try {
    const raw = await readFile(join(dir, "plugin.json"), "utf8");
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch (e: any) { throw new Error(`plugin.json is not valid JSON: ${e?.message ?? e}`); }
    manifest = validatePluginManifest(parsed, dirName);
    const seen = new Set<string>();
    for (const t of manifest.tools) {
      if (seen.has(t.name)) throw new Error(`duplicate tool name "${t.name}"`);
      seen.add(t.name);
    }
    res.id = manifest.id;
    res.tools = manifest.tools.map((t) => t.name);
    res.info.push(`manifest ok: ${manifest.id} ${manifest.version}, tools: ${res.tools.join(", ")}`);
  } catch (e: any) {
    res.errors.push(`plugin.json: ${String(e?.message ?? e)}`);
  }

  // 2. size and file count
  try {
    const { count, bytes } = await listFiles(dir);
    if (count > MAX_PLUGIN_FILES) res.errors.push(`too many files: ${count} (limit ${MAX_PLUGIN_FILES})`);
    if (bytes > MAX_PLUGIN_BYTES) res.errors.push(`too large: ${bytes} bytes (limit ${MAX_PLUGIN_BYTES})`);
    res.info.push(`${count} files, ${bytes} bytes`);
  } catch (e: any) {
    res.errors.push(`cannot read folder: ${String(e?.message ?? e)}`);
  }

  // 3. dependencies are refused (the plugin must be a single self-contained module set)
  try {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    for (const k of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      if (pkg?.[k] && Object.keys(pkg[k]).length > 0) {
        res.errors.push(`package.json has ${k}: plugins with dependencies are refused (bundle them into one file)`);
      }
    }
  } catch {
    // no package.json (or not JSON): nothing to refuse
  }

  if (!manifest) return res;

  // 4. main module: inside the folder, importable, exports a function per tool
  {
    const scanFiles: { path: string; text: string }[] = [];
    const walk = async (rel: string, depth: number): Promise<void> => {
      if (depth > 6 || scanFiles.length >= 200) return;
      for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
        if (e.name === ".git" || e.name === "node_modules") continue;
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(p, depth + 1);
        else if (e.isFile() && isScannedFile(p)) scanFiles.push({ path: p, text: await readFile(join(dir, p), "utf8") });
      }
    };
    await walk("", 0);
    const scan = scanPlugin({ files: scanFiles, tools: manifest.tools });
    const sum = summarizeFindings(scan.findings);
    res.info.push(`static scan (a hint, not a guarantee): high ${sum.high}, medium ${sum.medium}, info ${sum.info}`);
    for (const f of scan.findings.filter((x) => x.severity !== "info")) res.warnings.push(`[${f.severity}] ${f.rule} ${f.file}:${f.line}  ${f.snippet}`);
    for (const m of scan.permissionMismatch) res.warnings.push(`tool ${m.tool} uses undeclared: ${m.used.join(", ")}`);
  }
  const file = resolve(dir, manifest.main);
  let tools: Record<string, unknown> | undefined;
  if (!file.startsWith(dir + sep)) {
    res.errors.push(`main "${manifest.main}" must stay inside the plugin directory`);
  } else if (!existsSync(file)) {
    res.errors.push(`main file not found: ${manifest.main}`);
  } else {
    try {
      const mod: any = await import(`${pathToFileURL(file).href}?check=${Date.now()}`);
      if (!mod || typeof mod.tools !== "object" || !mod.tools) {
        res.errors.push("module does not export `tools` (use: export const tools = { ... })");
      } else {
        tools = mod.tools;
      }
    } catch (e: any) {
      res.errors.push(`failed to load ${manifest.main}: ${String(e?.message ?? e)}`);
    }
  }
  for (const t of manifest.tools) {
    if (tools && typeof tools[t.name] !== "function") {
      res.errors.push(`module does not export a function for tool "${t.name}"`);
    }
  }

  // 5. run each tool once with {} and a stub ctx (problems are warnings)
  if (tools && opts.runTools !== false) {
    for (const t of manifest.tools) {
      const fn = tools[t.name];
      if (typeof fn !== "function") continue;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), RUN_TIMEOUT_MS);
      const ctx: Record<string, unknown> = {
        log: (msg: string) => res.info.push(`[${t.name}] ${String(msg)}`),
        signal: ac.signal,
        userId: "check",
        config: {},
      };
      if (t.permissions.includes("network")) ctx.fetch = fetch;
      try {
        const out = await Promise.race([
          Promise.resolve((fn as (a: unknown, c: unknown) => unknown)({}, ctx)),
          new Promise((_, rej) => ac.signal.addEventListener("abort", () => rej(new Error(`timed out after ${RUN_TIMEOUT_MS} ms`)))),
        ]);
        res.info.push(`${t.name}({}) returned ${typeof out === "string" ? "text" : JSON.stringify(out)?.slice(0, 200) ?? String(out)}`);
      } catch (e: any) {
        res.warnings.push(`${t.name}({}) threw: ${String(e?.message ?? e)} (a required argument may be missing; this is not a failure)`);
      } finally {
        clearTimeout(timer);
      }
    }
  }
  return res;
}

export function formatReport(r: CheckResult): string {
  const lines: string[] = [`plugin:check ${r.dir}`];
  for (const i of r.info) lines.push(`  info     ${i}`);
  for (const w of r.warnings) lines.push(`  warning  ${w}`);
  for (const e of r.errors) lines.push(`  ERROR    ${e}`);
  lines.push(r.errors.length ? `FAILED: ${r.errors.length} error(s), ${r.warnings.length} warning(s)`
    : `OK: ${r.warnings.length} warning(s)`);
  return lines.join("\n");
}
