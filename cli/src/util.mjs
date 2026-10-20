// Shared helpers: errors, stdin reading, redaction.

export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export class UsageError extends CliError {
  constructor(message) {
    super(message, 2);
    this.usage = true;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function readAll(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(typeof c === "string" ? Buffer.from(c, "utf8") : c);
  return Buffer.concat(chunks).toString("utf8");
}

/** Build a redaction function. `secrets` is a live Set of literal secret values. */
export function makeRedactor(secrets) {
  return (input) => {
    let s = String(input);
    for (const sec of secrets) {
      if (typeof sec === "string" && sec.length >= 4) s = s.split(sec).join("***");
    }
    return s
      .replace(/(token=)[^&\s"']+/gi, "$1***")
      .replace(/(Bearer\s+)[^\s"']+/gi, "$1***")
      .replace(/ocsk-[A-Za-z0-9_-]+/g, "ocsk-***")
      .replace(/\b[0-9a-f]{64}\b/g, "***");
  };
}

const SENSITIVE_KEYS = /^(password|token|apikey|api_key|key|secret|authorization)$/i;
export function redactObject(v) {
  if (Array.isArray(v)) return v.map(redactObject);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = SENSITIVE_KEYS.test(k) ? "***" : redactObject(val);
    return o;
  }
  return v;
}

export function fmtDate(ms) {
  if (typeof ms !== "number") return "";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function truncate(s, n) {
  s = String(s ?? "").replace(/\s+/g, " ");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Validate a string flag against an allowed list (usage error otherwise). */
export function oneOf(value, values, name) {
  if (value === undefined) return undefined;
  if (!values.includes(value)) throw new UsageError(`--${name} must be one of: ${values.join(", ")}`);
  return value;
}
