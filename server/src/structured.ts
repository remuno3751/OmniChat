/* Structured output helpers (PROTOCOL-v3-phase4.md section 1). Pure module: no db import. */

export type ResponseFormat =
  | { type: "json_object" }
  | { type: "json_schema"; name?: string; schema: Record<string, unknown> };

export const MAX_SCHEMA_BYTES = 64 * 1024;
export const MAX_GRAMMAR_CHARS = 100_000;
export const MAX_EXTRA_BODY_BYTES = 32 * 1024;
/** extraBody may never override these body fields. */
export const FORBIDDEN_EXTRA_KEYS: readonly string[] = ["model", "messages", "stream", "tools", "stream_options", "response_format"];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** undefined = invalid; null = none. Unknown keys are dropped. */
export function sanitizeResponseFormat(v: unknown): ResponseFormat | null | undefined {
  if (v === null || v === undefined) return null;
  if (!isObj(v)) return undefined;
  if (v.type === "json_object") return { type: "json_object" };
  if (v.type === "json_schema") {
    if (!isObj(v.schema)) return undefined;
    let size = 0;
    try { size = Buffer.byteLength(JSON.stringify(v.schema), "utf8"); } catch { return undefined; }
    if (size > MAX_SCHEMA_BYTES) return undefined;
    const out: ResponseFormat = { type: "json_schema", schema: v.schema };
    if (typeof v.name === "string" && v.name.trim()) out.name = v.name.trim().slice(0, 64);
    return out;
  }
  return undefined;
}

/** Parses the DB column. */
export function parseResponseFormat(raw: unknown): ResponseFormat | null {
  if (typeof raw !== "string" || !raw) return null;
  try { return sanitizeResponseFormat(JSON.parse(raw)) ?? null; } catch { return null; }
}

/** one-shot > conversation > none */
export function resolveResponseFormat(oneShot: unknown, conversation: ResponseFormat | null): ResponseFormat | null {
  const o = sanitizeResponseFormat(oneShot);
  return o ?? conversation ?? null;
}

/** OpenAI `response_format` body value. */
export function toWireResponseFormat(rf: ResponseFormat): Record<string, unknown> {
  if (rf.type === "json_object") return { type: "json_object" };
  const name = (rf.name ?? "response").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "response";
  return { type: "json_schema", json_schema: { name, schema: rf.schema, strict: true } };
}

/** Drops forbidden keys; null when empty / invalid / too large. */
export function sanitizeExtraBody(v: unknown): Record<string, unknown> | null {
  if (!isObj(v)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (!k || k === "__proto__" || FORBIDDEN_EXTRA_KEYS.includes(k)) continue;
    out[k] = x;
  }
  if (!Object.keys(out).length) return null;
  try { if (Buffer.byteLength(JSON.stringify(out), "utf8") > MAX_EXTRA_BODY_BYTES) return null; } catch { return null; }
  return out;
}

/** Throws a message for obviously unacceptable extra params (used by the PUT endpoints for a clear 400). */
export function paramsProblem(v: unknown): string | null {
  if (!isObj(v)) return null;
  if ("extraBody" in v && v.extraBody !== null && v.extraBody !== undefined) {
    if (!isObj(v.extraBody)) return "extraBody must be an object or null";
    try {
      if (Buffer.byteLength(JSON.stringify(v.extraBody), "utf8") > MAX_EXTRA_BODY_BYTES) return `extraBody is larger than ${MAX_EXTRA_BODY_BYTES} bytes`;
    } catch { return "extraBody must be JSON"; }
  }
  if ("logprobs" in v && v.logprobs !== null && v.logprobs !== undefined) {
    if (typeof v.logprobs !== "number" || !Number.isInteger(v.logprobs) || v.logprobs < 0 || v.logprobs > 20) return "logprobs must be an integer 0..20 or null";
  }
  if ("grammar" in v && v.grammar !== null && v.grammar !== undefined) {
    if (typeof v.grammar !== "string" || v.grammar.length > MAX_GRAMMAR_CHARS) return `grammar must be a string of at most ${MAX_GRAMMAR_CHARS} characters or null`;
  }
  return null;
}

/** Applies extraBody to a request body, never touching the forbidden keys. */
export function applyExtraBody(body: Record<string, unknown>, extra: unknown): void {
  const e = sanitizeExtraBody(extra);
  if (!e) return;
  for (const [k, x] of Object.entries(e)) body[k] = x;
}

/* ---------------- validation of the produced JSON ---------------- */

export interface JsonCheck { valid: boolean; error?: string }

const typeOf = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v;

function typeMatches(want: string, v: unknown): boolean {
  const t = typeOf(v);
  if (want === t) return true;
  return want === "number" && t === "integer";
}

/** Minimal JSON-schema check: type / enum / const / required / properties / items / min-max length+items+value. Returns the first problem. */
export function validateAgainstSchema(value: unknown, schema: unknown, path = "$", depth = 0): string | null {
  if (!isObj(schema) || depth > 32) return null;
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    return `${path}: value is not one of the allowed enum values`;
  }
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) return `${path}: value does not equal the required constant`;
  const t = schema.type;
  if (typeof t === "string" || Array.isArray(t)) {
    const types = (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === "string");
    if (types.length && !types.some((w) => typeMatches(w, value))) return `${path}: expected ${types.join("|")} but got ${typeOf(value)}`;
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${path}: shorter than minLength ${schema.minLength}`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${path}: longer than maxLength ${schema.maxLength}`;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${path}: below minimum ${schema.minimum}`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${path}: above maximum ${schema.maximum}`;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path}: fewer than minItems ${schema.minItems}`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${path}: more than maxItems ${schema.maxItems}`;
    if (isObj(schema.items)) {
      for (let i = 0; i < value.length; i++) {
        const p = validateAgainstSchema(value[i], schema.items, `${path}[${i}]`, depth + 1);
        if (p) return p;
      }
    }
  }
  if (isObj(value)) {
    if (Array.isArray(schema.required)) {
      for (const r of schema.required) if (typeof r === "string" && !(r in value)) return `${path}: missing required property "${r}"`;
    }
    if (isObj(schema.properties)) {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in value) {
          const p = validateAgainstSchema(value[k], sub, `${path}.${k}`, depth + 1);
          if (p) return p;
        }
      }
      if (schema.additionalProperties === false) {
        for (const k of Object.keys(value)) if (!(k in (schema.properties as object))) return `${path}: unexpected property "${k}"`;
      }
    }
  }
  return null;
}

/** JSON.parse the content (+ schema check for json_schema). json_object additionally requires an object at the top level. */
export function checkJson(content: string, rf: ResponseFormat): JsonCheck {
  let value: unknown;
  try { value = JSON.parse(content); } catch (e) {
    return { valid: false, error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
  }
  if (rf.type === "json_object") {
    return isObj(value) ? { valid: true } : { valid: false, error: `expected a JSON object but got ${typeOf(value)}` };
  }
  const problem = validateAgainstSchema(value, rf.schema);
  return problem ? { valid: false, error: problem.slice(0, 300) } : { valid: true };
}
