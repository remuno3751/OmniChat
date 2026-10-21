/**
 * Hand-written argument validators for the 12 bridge tools (pure, no deps).
 * Spec: docs/design/VSCODE-BRIDGE.md §3 (args table, `additionalProperties:false`).
 *
 * Out-of-range numbers are rejected (not clamped): the spec gives maxima only.
 * Defaults are applied to the returned args so handlers never see `undefined`.
 */
import type { ToolName } from "../protocol/frames";
import {
  GIT_COMMIT_MAX_MESSAGE_CHARS,
  GIT_DIFF_MAX_CONTEXT,
  GIT_DIFF_MIN_CONTEXT,
  GIT_DIFF_DEFAULT_CONTEXT,
  GIT_LOG_DEFAULT_LIMIT,
  GIT_LOG_MAX_LIMIT,
  GLOB_DEFAULT_LIMIT,
  GLOB_MAX_LIMIT,
  GREP_DEFAULT_LIMIT,
  GREP_MAX_CONTEXT,
  GREP_MAX_LIMIT,
  GREP_MIN_CONTEXT,
  LIST_DIR_DEFAULT_DEPTH,
  LIST_DIR_MAX_DEPTH,
  LIST_DIR_MIN_DEPTH,
  DIAGNOSTICS_DEFAULT_LIMIT,
  READ_FILE_DEFAULT_LIMIT_LINES,
  READ_FILE_MAX_LIMIT_LINES,
  RUN_COMMAND_DEFAULT_TIMEOUT_MS,
  RUN_COMMAND_MAX_CHARS,
  RUN_COMMAND_MAX_TIMEOUT_MS,
  WRITE_FILE_MAX_BYTES,
} from "./limits";

// ---------------------------------------------------------------------------
// Validated argument types (defaults already applied where the spec gives one)
// ---------------------------------------------------------------------------

export interface ReadFileArgs {
  path: string;
  offset: number;
  limit: number;
}
export interface ListDirArgs {
  path: string;
  depth: number;
  includeHidden: boolean;
}
export interface GlobArgs {
  pattern: string;
  path?: string;
  limit: number;
}
export interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  regex: boolean;
  caseSensitive: boolean;
  context: number;
  limit: number;
}
export interface WriteFileArgs {
  path: string;
  content: string;
  createDirs: boolean;
}
export interface EditFileArgs {
  path: string;
  oldString: string;
  newString: string;
  replaceAll: boolean;
}
export interface RunCommandArgs {
  command: string;
  cwd?: string;
  timeoutMs: number;
}
export interface GetDiagnosticsArgs {
  path?: string;
  severity: "error" | "warning" | "all";
  limit: number;
}
export type GitStatusArgs = Record<string, never>;
export interface GitDiffArgs {
  staged: boolean;
  path?: string;
  base?: string;
  context: number;
}
export interface GitLogArgs {
  limit: number;
  path?: string;
  ref?: string;
}
export interface GitCommitArgs {
  message: string;
  paths?: string[];
  all: boolean;
}

/** Maps each tool name to its validated args type. */
export interface ToolArgsMap {
  read_file: ReadFileArgs;
  list_dir: ListDirArgs;
  glob: GlobArgs;
  grep: GrepArgs;
  write_file: WriteFileArgs;
  edit_file: EditFileArgs;
  run_command: RunCommandArgs;
  get_diagnostics: GetDiagnosticsArgs;
  git_status: GitStatusArgs;
  git_diff: GitDiffArgs;
  git_log: GitLogArgs;
  git_commit: GitCommitArgs;
}

export type ValidateResult<T> = { ok: true; args: T } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Field helpers. They throw ArgError; `validateArgs` converts that to a result.
// ---------------------------------------------------------------------------

class ArgError extends Error {}

function fail(message: string): never {
  throw new ArgError(message);
}

type Obj = Record<string, unknown>;

function asObject(input: unknown, allowed: readonly string[]): Obj {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("args must be an object");
  }
  const o = input as Obj;
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) fail(`unknown argument "${key}"`);
  }
  return o;
}

function charLength(s: string): number {
  return s.length <= 0 ? 0 : Array.from(s).length;
}

function reqStr(o: Obj, key: string, max?: number): string {
  const v = o[key];
  if (v === undefined) fail(`"${key}" is required`);
  return checkStr(v, key, max, false);
}

function optStr(o: Obj, key: string, max?: number, allowEmpty = false): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  return checkStr(v, key, max, allowEmpty);
}

function checkStr(v: unknown, key: string, max: number | undefined, allowEmpty: boolean): string {
  if (typeof v !== "string") fail(`"${key}" must be a string`);
  const s = v as string;
  if (!allowEmpty && s.length === 0) fail(`"${key}" must not be empty`);
  if (max !== undefined && charLength(s) > max) fail(`"${key}" must be at most ${max} characters`);
  return s;
}

function optInt(o: Obj, key: string, min: number, max: number, def: number): number {
  const v = o[key];
  if (v === undefined) return def;
  if (typeof v !== "number" || !Number.isInteger(v)) fail(`"${key}" must be an integer`);
  const n = v as number;
  if (n < min || n > max) fail(`"${key}" must be between ${min} and ${max}`);
  return n;
}

function optBool(o: Obj, key: string, def: boolean): boolean {
  const v = o[key];
  if (v === undefined) return def;
  if (typeof v !== "boolean") fail(`"${key}" must be a boolean`);
  return v as boolean;
}

function optEnum<T extends string>(o: Obj, key: string, values: readonly T[], def: T): T {
  const v = o[key];
  if (v === undefined) return def;
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) {
    fail(`"${key}" must be one of ${values.map((x) => `"${x}"`).join(", ")}`);
  }
  return v as T;
}

function optStrArray(o: Obj, key: string): string[] | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) fail(`"${key}" must be an array of strings`);
  return (v as unknown[]).map((item) => checkStr(item, `${key}[]`, undefined, false));
}

// ---------------------------------------------------------------------------
// Per-tool validators
// ---------------------------------------------------------------------------

type Validator<T> = (input: unknown) => T;

const readFile: Validator<ReadFileArgs> = (input) => {
  const o = asObject(input, ["path", "offset", "limit"]);
  return {
    path: reqStr(o, "path"),
    offset: optInt(o, "offset", 1, Number.MAX_SAFE_INTEGER, 1),
    limit: optInt(o, "limit", 1, READ_FILE_MAX_LIMIT_LINES, READ_FILE_DEFAULT_LIMIT_LINES),
  };
};

const listDir: Validator<ListDirArgs> = (input) => {
  const o = asObject(input, ["path", "depth", "includeHidden"]);
  return {
    path: optStr(o, "path") ?? ".",
    depth: optInt(o, "depth", LIST_DIR_MIN_DEPTH, LIST_DIR_MAX_DEPTH, LIST_DIR_DEFAULT_DEPTH),
    includeHidden: optBool(o, "includeHidden", false),
  };
};

const glob: Validator<GlobArgs> = (input) => {
  const o = asObject(input, ["pattern", "path", "limit"]);
  const out: GlobArgs = {
    pattern: reqStr(o, "pattern"),
    limit: optInt(o, "limit", 1, GLOB_MAX_LIMIT, GLOB_DEFAULT_LIMIT),
  };
  const path = optStr(o, "path");
  if (path !== undefined) out.path = path;
  return out;
};

const grep: Validator<GrepArgs> = (input) => {
  const o = asObject(input, [
    "pattern",
    "path",
    "glob",
    "regex",
    "caseSensitive",
    "context",
    "limit",
  ]);
  const out: GrepArgs = {
    pattern: reqStr(o, "pattern"),
    regex: optBool(o, "regex", true),
    caseSensitive: optBool(o, "caseSensitive", false),
    context: optInt(o, "context", GREP_MIN_CONTEXT, GREP_MAX_CONTEXT, 0),
    limit: optInt(o, "limit", 1, GREP_MAX_LIMIT, GREP_DEFAULT_LIMIT),
  };
  const path = optStr(o, "path");
  if (path !== undefined) out.path = path;
  const include = optStr(o, "glob");
  if (include !== undefined) out.glob = include;
  return out;
};

const writeFile: Validator<WriteFileArgs> = (input) => {
  const o = asObject(input, ["path", "content", "createDirs"]);
  const path = reqStr(o, "path");
  const content = o["content"];
  if (content === undefined) fail(`"content" is required`);
  if (typeof content !== "string") fail(`"content" must be a string`);
  if (new TextEncoder().encode(content).length > WRITE_FILE_MAX_BYTES) {
    fail(`"content" must be at most ${WRITE_FILE_MAX_BYTES} bytes`);
  }
  return { path, content, createDirs: optBool(o, "createDirs", true) };
};

const editFile: Validator<EditFileArgs> = (input) => {
  const o = asObject(input, ["path", "oldString", "newString", "replaceAll"]);
  const path = reqStr(o, "path");
  const oldString = reqStr(o, "oldString");
  const newString = o["newString"];
  if (newString === undefined) fail(`"newString" is required`);
  if (typeof newString !== "string") fail(`"newString" must be a string`);
  return {
    path,
    oldString,
    newString: newString as string,
    replaceAll: optBool(o, "replaceAll", false),
  };
};

const runCommand: Validator<RunCommandArgs> = (input) => {
  const o = asObject(input, ["command", "cwd", "timeoutMs"]);
  const out: RunCommandArgs = {
    command: reqStr(o, "command", RUN_COMMAND_MAX_CHARS),
    timeoutMs: optInt(
      o,
      "timeoutMs",
      1,
      RUN_COMMAND_MAX_TIMEOUT_MS,
      RUN_COMMAND_DEFAULT_TIMEOUT_MS,
    ),
  };
  const cwd = optStr(o, "cwd");
  if (cwd !== undefined) out.cwd = cwd;
  return out;
};

const getDiagnostics: Validator<GetDiagnosticsArgs> = (input) => {
  const o = asObject(input, ["path", "severity", "limit"]);
  const out: GetDiagnosticsArgs = {
    severity: optEnum(o, "severity", ["error", "warning", "all"] as const, "warning"),
    limit: optInt(o, "limit", 1, Number.MAX_SAFE_INTEGER, DIAGNOSTICS_DEFAULT_LIMIT),
  };
  const path = optStr(o, "path");
  if (path !== undefined) out.path = path;
  return out;
};

const gitStatus: Validator<GitStatusArgs> = (input) => {
  asObject(input, []);
  return {};
};

const gitDiff: Validator<GitDiffArgs> = (input) => {
  const o = asObject(input, ["staged", "path", "base", "context"]);
  const out: GitDiffArgs = {
    staged: optBool(o, "staged", false),
    context: optInt(
      o,
      "context",
      GIT_DIFF_MIN_CONTEXT,
      GIT_DIFF_MAX_CONTEXT,
      GIT_DIFF_DEFAULT_CONTEXT,
    ),
  };
  const path = optStr(o, "path");
  if (path !== undefined) out.path = path;
  const base = optStr(o, "base");
  if (base !== undefined) out.base = base;
  return out;
};

const gitLog: Validator<GitLogArgs> = (input) => {
  const o = asObject(input, ["limit", "path", "ref"]);
  const out: GitLogArgs = {
    limit: optInt(o, "limit", 1, GIT_LOG_MAX_LIMIT, GIT_LOG_DEFAULT_LIMIT),
  };
  const path = optStr(o, "path");
  if (path !== undefined) out.path = path;
  const ref = optStr(o, "ref");
  if (ref !== undefined) out.ref = ref;
  return out;
};

const gitCommit: Validator<GitCommitArgs> = (input) => {
  const o = asObject(input, ["message", "paths", "all"]);
  const message = reqStr(o, "message", GIT_COMMIT_MAX_MESSAGE_CHARS);
  if (message.trim().length === 0) fail(`"message" must not be blank`);
  const out: GitCommitArgs = { message, all: optBool(o, "all", false) };
  const paths = optStrArray(o, "paths");
  if (paths !== undefined) out.paths = paths;
  return out;
};

const VALIDATORS: { [K in ToolName]: Validator<ToolArgsMap[K]> } = {
  read_file: readFile,
  list_dir: listDir,
  glob,
  grep,
  write_file: writeFile,
  edit_file: editFile,
  run_command: runCommand,
  get_diagnostics: getDiagnostics,
  git_status: gitStatus,
  git_diff: gitDiff,
  git_log: gitLog,
  git_commit: gitCommit,
};

/** Tool names this module knows how to validate. */
export const TOOL_NAMES: readonly ToolName[] = Object.keys(VALIDATORS) as ToolName[];

/** Type guard: true when `name` is one of the 12 v1 tools. */
export function isToolName(name: unknown): name is ToolName {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(VALIDATORS, name);
}

/**
 * Validates `args` for `tool` per spec §3. Never throws.
 * On success returns the args with defaults applied; on failure a human-readable error.
 */
export function validateArgs<N extends ToolName>(
  tool: N,
  args: unknown,
): ValidateResult<ToolArgsMap[N]> {
  if (!isToolName(tool)) return { ok: false, error: `unknown tool "${String(tool)}"` };
  try {
    const validate = VALIDATORS[tool] as Validator<ToolArgsMap[N]>;
    return { ok: true, args: validate(args) };
  } catch (err) {
    if (err instanceof ArgError) return { ok: false, error: err.message };
    throw err;
  }
}
