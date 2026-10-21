/**
 * VS Code bridge approval policy (docs/design/VSCODE-BRIDGE.md section 4).
 * Pure: no db access. Evaluation order: deny rule > protected (ask) > allow rule > mode table > default ask.
 * The protected matcher is a lexical port of vscode-ext/src/guard (vscode-*.ts files here); the server does no realpath.
 */
import { checkProtected, type ToolName } from "./vscode-protected.js";

export type ToolClass = "read" | "edit" | "exec" | "gitwrite";
export type ApprovalMode = "manual" | "auto" | "full";

const CLASSES: Record<string, ToolClass> = {
  read_file: "read", list_dir: "read", glob: "read", grep: "read", get_diagnostics: "read",
  git_status: "read", git_diff: "read", git_log: "read",
  write_file: "edit", edit_file: "edit",
  run_command: "exec",
  git_commit: "gitwrite",
};

/** Unknown tools are treated as exec (most restrictive non-git class). */
export const toolClass = (tool: string): ToolClass => CLASSES[tool] ?? "exec";

const isWinStyle = (p: string): boolean => /^[A-Za-z]:|^[\\/]{2}/.test(p);

export interface ProtectedMatch { protected: boolean; ids: string[]; reasons: string[] }

/** Spec 4.3: P1-P3, C-git, C-rm, C-path, C-sys, unparseable. Lexical only. */
export function matchProtected(tool: string, args: Record<string, unknown>, roots: string[]): ProtectedMatch {
  const v = checkProtected(
    { tool: tool as ToolName, args },
    { roots, cwd: roots[0] ?? "", platform: roots.some(isWinStyle) ? "win32" : "posix" },
  );
  return v.protected ? { protected: true, ids: [v.rule], reasons: [v.reason] } : { protected: false, ids: [], reasons: [] };
}

/** Auto-mode allow list (spec 4.1); each may be followed by whitespace-separated arguments. */
export const ALLOWLIST: readonly string[] = [
  "npm test", "npm run test", "npm run lint", "npm run build", "npm run typecheck",
  "pnpm test", "yarn test", "npx tsc --noEmit", "tsc --noEmit", "pytest", "cargo test", "cargo check",
  "go test ./...", "git status", "git diff", "git log",
];

/** Shell metacharacters: `; & | < > backtick $( ${` and newlines. */
export const SHELL_META = /[;&|<>`\n\r]|\$[({]/;

export function isAllowlisted(command: string): boolean {
  if (typeof command !== "string" || SHELL_META.test(command)) return false;
  const c = command.trim().replace(/\s+/g, " ");
  return ALLOWLIST.some((a) => c === a || c.startsWith(a + " "));
}

/** `*` any chars, `?` one char; anchored, case-sensitive (same semantics as approval-rules globMatch). */
function globMatch(glob: string, s: string): boolean {
  const g = [...glob], t = [...s];
  let gi = 0, ti = 0, star = -1, mark = 0;
  while (ti < t.length) {
    if (gi < g.length && g[gi] !== "*" && (g[gi] === "?" || g[gi] === t[ti])) { gi++; ti++; }
    else if (gi < g.length && g[gi] === "*") { star = gi++; mark = ti; }
    else if (star >= 0) { gi = star + 1; ti = ++mark; }
    else return false;
  }
  while (gi < g.length && g[gi] === "*") gi++;
  return gi === g.length;
}

/** Same shape as the v4 approval rules (kind/pattern); `project` marks a project-scoped rule (wins over global ones). */
export interface PolicyRule { id: string; kind: "tool" | "command" | "path" | string; pattern: string; project?: boolean }
export interface PolicyRules { deny: PolicyRule[]; allow: PolicyRule[] }

export interface DecideInput {
  tool: string;
  args: Record<string, unknown>;
  roots: string[];
  mode: ApprovalMode;
  rules: PolicyRules;
}
export interface Decision {
  action: "allow" | "ask" | "deny";
  by: string;
  protected: boolean;
  reasons: string[];
  /** false for protected items: the dialog must not offer "always allow". */
  alwaysAllowed?: false;
}

function ruleMatches(r: PolicyRule, allow: boolean, tool: string, command: string | undefined, path: string | undefined): boolean {
  if (r.kind === "tool") return r.pattern === tool;
  if (r.kind === "command") return command !== undefined && !(allow && SHELL_META.test(command)) && globMatch(r.pattern, command);
  if (r.kind === "path") return path !== undefined && globMatch(r.pattern, path);
  return false;
}

function modeAllows(cls: ToolClass, mode: ApprovalMode, args: Record<string, unknown>): boolean {
  if (cls === "read") return true;
  if (mode === "full") return true;
  if (mode === "auto") {
    if (cls === "edit") return true;
    if (cls === "exec") return isAllowlisted(String(args.command ?? ""));
  }
  return false;
}

export function decide(input: DecideInput): Decision {
  const { tool, args, roots, mode, rules } = input;
  const p = matchProtected(tool, args, roots);
  const command = typeof args.command === "string" ? args.command : undefined;
  const path = typeof args.path === "string" ? args.path : undefined;
  const hit = (list: PolicyRule[], allow: boolean) => list.filter((r) => ruleMatches(r, allow, tool, command, path));
  const denyHits = hit(rules.deny, false), allowHits = hit(rules.allow, true);
  // project-scoped rules shadow global ones (as evaluateRules does)
  const scoped = (denyHits.some((r) => r.project) || allowHits.some((r) => r.project));
  const pool = (l: PolicyRule[]) => (scoped ? l.filter((r) => r.project) : l);
  const deny = pool(denyHits)[0];
  const reasons = p.reasons.map((r, i) => `${p.ids[i]}: ${r}`);
  if (deny) return { action: "deny", by: `rule:${deny.id}`, protected: p.protected, reasons: [`deny rule ${deny.id}`, ...reasons] };
  if (p.protected) return { action: "ask", by: "protected", protected: true, reasons, alwaysAllowed: false };
  const allow = pool(allowHits)[0];
  if (allow) return { action: "allow", by: `rule:${allow.id}`, protected: false, reasons: [`allow rule ${allow.id}`] };
  if (modeAllows(toolClass(tool), mode, args)) return { action: "allow", by: `mode:${mode}`, protected: false, reasons: [`${mode} mode`] };
  return { action: "ask", by: "default", protected: false, reasons: [`${toolClass(tool)} needs approval in ${mode} mode`] };
}
