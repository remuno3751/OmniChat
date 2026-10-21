/**
 * run_command analysis for checkProtected (spec §4.3: C-git, C-rm, C-path, C-sys, unparseable).
 *
 * Lexical only, built on parseShell / unwrap / pathArgs (./shell) and the path rules (./paths).
 * Kept apart from protected.ts to respect the file-size rule. protected.ts imports this file;
 * this file never imports protected.ts. Any input that cannot be analysed is protected
 * ("unparseable"): this is a safety net, not a sandbox.
 */
import { isGitInternal, isSecretPath, normalizePath, resolveInWorkspace, type RealpathFn } from "./paths";
import { hasExpansion, isRedirectOp, parseShell, pathArgs, unwrap } from "./shell";

export interface Hit {
  rule: string;
  reason: string;
}

export interface Ctx {
  roots: string[];
  /** Directory the command runs in (absolute when known). Relative literal paths resolve against it. */
  cwd: string;
  realpath?: RealpathFn;
  platform?: "posix" | "win32";
}

export const RULE = {
  outside: "P1-outside",
  gitWrite: "P2-git-write",
  secret: "P3-secret",
  git: "C-git",
  rm: "C-rm",
  path: "C-path",
  sys: "C-sys",
  unparseable: "unparseable",
} as const;

export const identityRealpath: RealpathFn = async (p) => p;

export const unparse = (reason: string): Hit => ({ rule: RULE.unparseable, reason });

const MAX_DEPTH = 8;
const SUDO = new Set(["sudo", "su", "doas"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const PWSH = new Set(["pwsh", "powershell"]);
const FETCHERS = new Set(["curl", "wget", "base64", "openssl"]);
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
/** Any download or decode piped into a shell interpreter (optionally via a wrapper such as sudo). */
const PIPE_TO_SHELL =
  /\|&?\s*(?:(?:sudo|env|exec|nohup|command|xargs)\s+)*(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|fish|pwsh|powershell)(?:\.exe)?\b/i;
/** Home-relative tokens are outside the roots (spec §4.3). */
const HOME_TOKEN = /^(?:~|\$\{?(?:HOME|USERPROFILE)\}?|%USERPROFILE%)/i;
/** cmd.exe single-letter switches such as /s or /b, which are not paths. */
const CMD_OPTION = /^\/[A-Za-z?]$/;
const ABS = /^(?:[A-Za-z]:|[\\/])/;

/** Lower-cased basename without a `.exe` suffix. */
export function cmdName(word: string): string {
  const i = Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\"));
  return word.slice(i + 1).toLowerCase().replace(/\.exe$/, "");
}

/** Joins a relative path onto `base`. Absolute paths and an empty base are returned unchanged. */
export function joinCwd(base: string, p: string): string {
  if (ABS.test(p) || base === "") return p;
  return `${base.replace(/[\\/]+$/, "")}/${p}`;
}

export type Inside = "ok" | "outside" | "invalid";

/** Whether `p` resolves inside any root. A relative `p` is taken relative to each root in turn. */
export async function insideRoots(ctx: Ctx, p: string): Promise<Inside> {
  if (ctx.roots.length === 0) return "outside";
  const rp = ctx.realpath ?? identityRealpath;
  let invalid = false;
  for (const root of ctx.roots) {
    const r = await resolveInWorkspace(root, p, rp);
    if (r.ok) return "ok";
    if (r.reason !== "outside_workspace") invalid = true;
  }
  return invalid ? "invalid" : "outside";
}

/** A literal command token that points outside the roots (C-path). Non-literal tokens use their literal prefix. */
async function literalOutside(ctx: Ctx, tok: string): Promise<boolean> {
  if (tok === "/dev/null") return false;
  if (HOME_TOKEN.test(tok) || /%[^%]+%/.test(tok)) return true;
  const lit = hasExpansion(tok) ? tok.split(/[$`*?[{]/)[0] : tok;
  if (lit === "") return false;
  return (await insideRoots(ctx, joinCwd(ctx.cwd, lit))) !== "ok";
}

/** C-path: literal tokens (any word) that match P2/P3, and path tokens that point outside. */
async function checkPaths(argv: string[], ctx: Ctx, git: boolean): Promise<Hit | null> {
  for (const tok of argv) {
    if (isRedirectOp(tok)) continue;
    if (isSecretPath(tok) || (!git && isGitInternal(tok))) {
      return { rule: RULE.path, reason: "literal secret or .git path" };
    }
  }
  for (const tok of pathArgs(argv)) {
    if (ctx.platform === "win32" && CMD_OPTION.test(tok)) continue;
    if (await literalOutside(ctx, tok)) {
      return { rule: RULE.path, reason: "path outside the workspace" };
    }
  }
  return null;
}

const isRecursiveFlag = (a: string): boolean =>
  a === "--recursive" || (a.startsWith("-") && !a.startsWith("--") && /[rR]/.test(a));

const isPsRecurse = (a: string): boolean => a.length > 2 && "-recurse".startsWith(a.toLowerCase());

/** rm target that is a root, home, a parent, or cannot be known statically. */
function dangerousRmTarget(t: string): boolean {
  if (hasExpansion(t) || t.includes("%")) return true;
  const n = normalizePath(t);
  return n === "" || n === ".." || n.startsWith("../") || /^(?:[A-Za-z]:)?\/$/.test(n);
}

function rmHit(args: string[]): Hit | null {
  const opts: string[] = [];
  const targets: string[] = [];
  let endOpts = false;
  for (const a of args) {
    if (!endOpts && a === "--") endOpts = true;
    else if (!endOpts && a.startsWith("-") && a.length > 1) opts.push(a);
    else targets.push(a);
  }
  if (opts.some(isRecursiveFlag)) return { rule: RULE.rm, reason: "recursive rm" };
  if (targets.some(dangerousRmTarget)) {
    return { rule: RULE.rm, reason: "rm of workspace root, home, parent or dynamic target" };
  }
  return null;
}

/** C-git over the arguments after `git` (global options such as -C and -c skipped). */
function gitHit(args: string[]): Hit | null {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) i += GIT_VALUE_OPTS.has(args[i]) ? 2 : 1;
  if (i >= args.length) return null;
  const sub = args[i];
  const rest = args.slice(i + 1);
  const has = (...xs: string[]): boolean => rest.some((a) => xs.includes(a));
  const why = (reason: string): Hit => ({ rule: RULE.git, reason });
  if (sub === "push") return why("git push");
  if (sub === "clean") return why("git clean");
  if (sub === "reset" && has("--hard")) return why("git reset --hard");
  if (["checkout", "switch", "restore"].includes(sub) && has("-f", "--force")) return why("forced checkout");
  if (sub === "branch" && (has("-D") || (has("--delete") && has("--force")))) return why("forced branch delete");
  if (sub === "stash" && has("drop", "clear")) return why("git stash drop or clear");
  if (sub === "filter-branch") return why("git filter-branch");
  if (sub === "update-ref" && has("-d")) return why("git update-ref -d");
  if (sub === "reflog" && has("expire", "delete")) return why("git reflog expire or delete");
  if (sub === "gc" && rest.some((a) => a.startsWith("--prune"))) return why("git gc --prune");
  const forced = rest.some(
    (a) => a === "-f" || a === "--force" || a.startsWith("--force-with-lease") || a === "--force-if-includes",
  );
  return forced ? why("force option") : null;
}

/** Checks one unwrapped command element (argv suffix whose [0] is the command). */
async function checkElement(c: string[], ctx: Ctx, depth: number): Promise<Hit | null> {
  const name = cmdName(c[0]);
  const args = c.slice(1);
  const sys = (reason: string): Hit => ({ rule: RULE.sys, reason });
  const rm = (reason: string): Hit => ({ rule: RULE.rm, reason });
  if (SUDO.has(name)) return sys("privilege escalation");
  if ((name === "chmod" || name === "chown") && args.some(isRecursiveFlag)) return sys("recursive chmod or chown");
  if (name === "git") return gitHit(args);
  if (name === "rm") return rmHit(args);
  if (["rmdir", "rd", "del", "erase"].includes(name) && args.some((a) => a.toLowerCase() === "/s")) {
    return rm("recursive delete (/s)");
  }
  if (name === "remove-item" && args.some(isPsRecurse)) return rm("Remove-Item -Recurse");
  if (name === "shred" || name.startsWith("mkfs") || (name === "dd" && args.some((a) => a.startsWith("of=")))) {
    return rm("destructive disk or file tool");
  }
  if (name === "find") {
    if (args.includes("-delete")) return rm("find -delete");
    const i = args.findIndex((a) => FIND_EXEC.has(a));
    return i < 0 ? null : checkArgv(args.slice(i + 1), ctx, depth + 1);
  }
  if (SHELLS.has(name)) {
    const i = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    return i >= 0 && i + 1 < args.length ? checkCommandString(args[i + 1], ctx, depth + 1) : null;
  }
  if (PWSH.has(name)) {
    if (args.some((a) => /^-(e|enc|encodedcommand)$/i.test(a))) return unparse("encoded PowerShell");
    const i = args.findIndex((a) => /^-(c|command)$/i.test(a));
    return i >= 0 && i + 1 < args.length
      ? checkCommandString(args.slice(i + 1).join(" "), ctx, depth + 1)
      : null;
  }
  if (name === "cmd") {
    const i = args.findIndex((a) => /^\/[ck]$/i.test(a));
    return i >= 0 ? checkCommandString(args.slice(i + 1).join(" "), ctx, depth + 1) : null;
  }
  if (name === "eval") return checkCommandString(args.join(" "), ctx, depth + 1);
  return null;
}

/** One simple command: wrapper chain first, then path tokens. */
async function checkArgv(argv: string[], ctx: Ctx, depth: number): Promise<Hit | null> {
  if (depth > MAX_DEPTH) return unparse("commands nested too deeply");
  const chain = unwrap(argv);
  for (const c of chain) {
    if (hasExpansion(c[0]) || (ctx.platform === "win32" && /[\^%!]/.test(c[0]))) {
      return unparse("command name is not a literal word");
    }
  }
  for (const c of chain) {
    const hit = await checkElement(c, ctx, depth);
    if (hit) return hit;
  }
  return checkPaths(argv, ctx, chain.some((c) => cmdName(c[0]) === "git"));
}

/**
 * Checks a full run_command string (or a nested `sh -c` / `eval` string).
 * Returns the first hit, or null when nothing is protected.
 */
export async function checkCommandString(command: string, ctx: Ctx, depth = 0): Promise<Hit | null> {
  if (depth > MAX_DEPTH) return unparse("commands nested too deeply");
  const text = ctx.platform === "win32" ? command.replace(/\\/g, "/") : command;
  const parsed = parseShell(text);
  if (!parsed.ok) return unparse("command could not be parsed");
  if (PIPE_TO_SHELL.test(text)) return { rule: RULE.sys, reason: "download or decode piped into a shell" };
  const names = parsed.commands.flatMap((argv) => unwrap(argv).map((c) => cmdName(c[0])));
  if (names.some((n) => SHELLS.has(n) || PWSH.has(n)) && names.some((n) => FETCHERS.has(n))) {
    return { rule: RULE.sys, reason: "fetch or decode combined with a shell" };
  }
  for (const argv of parsed.commands) {
    const hit = await checkArgv(argv, ctx, depth);
    if (hit) return hit;
  }
  return null;
}
