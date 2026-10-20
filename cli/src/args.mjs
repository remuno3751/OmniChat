import { UsageError } from "./util.mjs";

/**
 * One option table for every command. Types: "bool" | "string" | "int".
 * Enum-like values are validated by the command that uses them (see util.oneOf),
 * because e.g. --format means md|json for export and json|yaml for config.
 */
export const OPTS = {
  server: { type: "string" },
  debug: { type: "bool" },
  "no-color": { type: "bool" },
  timeout: { type: "int" },
  quiet: { type: "bool", alias: "q" },
  help: { type: "bool", alias: "h" },
  version: { type: "bool", alias: "v" },
  username: { type: "string" },
  register: { type: "bool" },
  json: { type: "bool" },
  provider: { type: "string" },
  all: { type: "bool" },
  model: { type: "string", alias: "m" },
  project: { type: "string", alias: "p" },
  "create-project": { type: "bool" },
  conv: { type: "string" },
  new: { type: "bool" },
  effort: { type: "string" },
  search: { type: "string" },
  system: { type: "string" },
  thinking: { type: "bool" },
  approve: { type: "string" },
  "idle-timeout": { type: "int" },
  stats: { type: "bool" },
  "no-sources": { type: "bool" },
  limit: { type: "int" },
  offset: { type: "int" },
  format: { type: "string" },
  output: { type: "string", alias: "o" },
  reasoning: { type: "bool" },
  "all-branches": { type: "bool" },
  targets: { type: "string" },
  repeats: { type: "int" },
  "no-warmup": { type: "bool" },
  "max-tokens": { type: "int" },
  mode: { type: "string" },
  "data-dir": { type: "string" },
};

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** Parse argv. Returns { flags (camelCase keys), positionals }. "-" and "--" handled like POSIX tools. */
export function parseArgs(argv, spec = OPTS) {
  const aliases = {};
  for (const [name, def] of Object.entries(spec)) if (def.alias) aliases[def.alias] = name;
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-" || !a.startsWith("-") || /^-\d/.test(a)) {
      positionals.push(a);
      continue;
    }
    let name;
    let inline;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      inline = eq === -1 ? undefined : a.slice(eq + 1);
    } else {
      name = aliases[a.slice(1)] ?? a.slice(1);
    }
    const def = spec[name];
    if (!def) throw new UsageError(`unknown option: ${a.split("=")[0]}`);
    const key = camel(name);
    if (def.type === "bool") {
      if (inline !== undefined) throw new UsageError(`--${name} does not take a value`);
      flags[key] = true;
      continue;
    }
    let val = inline;
    if (val === undefined) {
      val = argv[++i];
      if (val === undefined || (val.startsWith("-") && val !== "-" && !/^-\d/.test(val))) {
        throw new UsageError(`option --${name} requires a value`);
      }
    }
    if (def.type === "int") {
      if (!/^\d+$/.test(val) || Number(val) < 1) throw new UsageError(`--${name} must be a positive integer`);
      flags[key] = Number(val);
    } else {
      flags[key] = val;
    }
  }
  return { flags, positionals };
}
