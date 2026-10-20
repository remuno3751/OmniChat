import type { ToolPermission } from "./tools/types.js";

/* Static scan of plugin source (docs/PROTOCOL-v7-plugins.md, "静的スキャンの規則").
 * It is a heuristic to show the administrator what to look at before installing. It is NOT a sandbox and NOT a
 * guarantee: a determined author can evade every rule below. */

export type Severity = "high" | "medium" | "info";
export interface Finding { rule: string; severity: Severity; file: string; line: number; snippet: string }
export interface PermissionMismatch { tool: string; used: ToolPermission[]; declared: ToolPermission[] }
export interface ScanResult { findings: Finding[]; permissionMismatch: PermissionMismatch[] }
export interface ScanInput { files: { path: string; text: string }[]; tools: { name: string; permissions: readonly string[] }[] }
export interface ScanSummary { high: number; medium: number; info: number }

const MAX_FINDINGS = 500;
const SNIPPET_MAX = 200;
const LONG_LINE = 2000;

const SCANNED_RE = /\.(?:mjs|cjs|js|mts|cts|ts)$/i;
export const isScannedFile = (path: string): boolean => SCANNED_RE.test(path);

interface LineRule { rule: string; severity: Severity; re: RegExp }
const LINE_RULES: LineRule[] = [
  { rule: "child_process", severity: "high", re: /(?:node:)?child_process\b/ },
  { rule: "fs_write", severity: "high", re: /\b(?:writeFile|appendFile|rm|rmdir|unlink|rename|mkdir|copyFile|truncate|createWriteStream)(?:Sync)?\s*\(/ },
  { rule: "env_access", severity: "high", re: /\bprocess\.env\b/ },
  { rule: "eval", severity: "high", re: /\beval\s*\(|\bnew\s+Function\s*\(/ },
  { rule: "dynamic_import", severity: "medium", re: /\bimport\s*\((?!\s*(?:'[^'\n]*'|"[^"\n]*"|`[^`$\n]*`)\s*\))/ },
  { rule: "raw_network", severity: "medium", re: /(?:\bfrom\s+|\brequire\s*\(\s*|\bimport\s*\(\s*)['"](?:node:)?(?:http|https|net|dgram|tls)['"]|\bWebSocket\b/ },
  { rule: "fs_read", severity: "info", re: /(?:\bfrom\s+|\brequire\s*\(\s*)['"](?:node:)?fs(?:\/promises)?['"]|\b(?:readFile|readFileSync|readdir|readdirSync|createReadStream|readlink|stat|statSync|existsSync)\s*\(/ },
];
const FETCH_RE = /\bfetch\s*\(|\bctx\.fetch\b/;
const HEX_RUN_RE = /(?:\\x[0-9a-fA-F]{2}){20,}/;
const ATOB_RE = /\batob\s*\(/;
const EVAL_RE = /\beval\s*\(|\bnew\s+Function\s*\(/;

/** Code kind -> the permission that declares it (contract table). */
const RULE_PERMISSION: Record<string, ToolPermission> = {
  child_process: "shell",
  fs_write: "filesystem-write",
  fs_read: "filesystem-read",
  raw_network: "network",
};

const snip = (s: string): string => {
  const t = s.trim();
  return t.length > SNIPPET_MAX ? t.slice(0, SNIPPET_MAX) + "…" : t;
};

/** Pure: findings for every scanned file, plus per-tool permission mismatches. */
export function scanPlugin(input: ScanInput): ScanResult {
  const findings: Finding[] = [];
  const used = new Set<ToolPermission>();
  let usesFetch = false;
  const fetchLines: { file: string; line: number; text: string }[] = [];
  const declaredByAny = new Set<string>();
  for (const t of input.tools) for (const p of t.permissions) declaredByAny.add(p);

  const push = (f: Finding) => { if (findings.length < MAX_FINDINGS) findings.push(f); };

  for (const file of input.files) {
    if (!isScannedFile(file.path)) continue;
    const lines = file.text.split(/\r?\n/);
    lines.forEach((text, i) => {
      const line = i + 1;
      for (const r of LINE_RULES) {
        if (!r.re.test(text)) continue;
        push({ rule: r.rule, severity: r.severity, file: file.path, line, snippet: snip(text) });
        const perm = RULE_PERMISSION[r.rule];
        if (perm) used.add(perm);
        if (r.rule === "raw_network") usesFetch = true;
      }
      if (FETCH_RE.test(text)) { usesFetch = true; fetchLines.push({ file: file.path, line, text }); }
      if (text.length > LONG_LINE) push({ rule: "obfuscation", severity: "medium", file: file.path, line, snippet: `(${text.length} 文字の長い行) ${snip(text.slice(0, 80))}` });
      if (HEX_RUN_RE.test(text)) push({ rule: "obfuscation", severity: "medium", file: file.path, line, snippet: snip(text) });
    });
    // atob + eval in one file: a common decode-then-run pattern
    if (ATOB_RE.test(file.text) && EVAL_RE.test(file.text)) {
      const at = lines.findIndex((l) => ATOB_RE.test(l));
      push({ rule: "obfuscation", severity: "medium", file: file.path, line: at + 1, snippet: snip(lines[at] ?? "atob") });
    }
  }

  if (usesFetch) used.add("network");
  // fetch without any tool declaring "network"
  if (usesFetch && !declaredByAny.has("network")) {
    for (const f of fetchLines) push({ rule: "undeclared_network", severity: "high", file: f.file, line: f.line, snippet: snip(f.text) });
  }

  const missing = [...used].filter((p) => !declaredByAny.has(p));
  const permissionMismatch: PermissionMismatch[] = [];
  if (missing.length) {
    for (const t of input.tools) {
      permissionMismatch.push({ tool: t.name, used: missing, declared: t.permissions as ToolPermission[] });
    }
  }
  return { findings, permissionMismatch };
}

/** Counts per severity (stored in plugin_installs.scan_json and shown in the plugin list). */
export function summarizeFindings(findings: { severity: Severity }[]): ScanSummary {
  const s: ScanSummary = { high: 0, medium: 0, info: 0 };
  for (const f of findings) s[f.severity] += 1;
  return s;
}
