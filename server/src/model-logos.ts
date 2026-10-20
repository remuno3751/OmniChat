import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";

/*
 * Model logos: the Hugging Face organization behind a model, and that organization's avatar.
 * Origin resolution: family table, then LM Studio publisher, then the id's org prefix (all local),
 * then a Hugging Face search (base_model of the matching repo, else its author).
 * Avatars are cached on disk under DATA_DIR/cache/model-logos (found: 30 days, missing: 24 h).
 * Config is read on every call. OMNICHAT_MODEL_LOGOS=0 disables every outbound request.
 */

const DAY = 86_400_000;
const POS_TTL = 30 * DAY;
const NEG_TTL = DAY;
const FETCH_TIMEOUT = 6_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_HOPS = 3;
const ORG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9._-]{1,96}$/;
const FILE_RE = /^[A-Za-z0-9._-]+\.(png|jpg|webp|svg|gif)$/;

/** Ordered: the first match wins. Tested against the lowercased model name without its org/ prefix. */
const FAMILY: Array<[RegExp, string]> = [
  [/deepseek/, "deepseek-ai"],
  [/gemma|gemini/, "google"],
  [/qwen|qwq/, "Qwen"],
  [/llama/, "meta-llama"],
  [/mistral|mixtral|ministral|devstral|magistral|codestral/, "mistralai"],
  [/(^|[^a-z])phi(?![a-z])/, "microsoft"],
  [/lfm/, "LiquidAI"],
  [/nemotron/, "nvidia"],
  [/gpt-oss/, "openai"],
  [/glm/, "zai-org"],
  [/kimi/, "moonshotai"],
  [/granite/, "ibm-granite"],
  [/command/, "CohereLabs"],
  [/olmo/, "allenai"],
  [/smollm/, "HuggingFaceTB"],
  [/(^|[^a-z])yi(?![a-z])/, "01-ai"],
  [/falcon/, "tiiuae"],
  [/internlm/, "internlm"],
  [/minicpm/, "openbmb"],
  [/ernie/, "baidu"],
  [/hunyuan/, "tencent"],
  [/(^|[^a-z])step(?![a-z])/, "stepfun-ai"],
  [/(^|[^a-z])seed(?![a-z])/, "ByteDance-Seed"],
];

/** Quantizers and re-uploaders: their name says nothing about the model's maker. Lowercase. */
const REPACKAGERS = new Set([
  "lmstudio-community", "lmstudio", "lmstudio-ai", "mradermacher", "unsloth", "bartowski", "thebloke",
  "maziyarpanahi", "quantfactory", "mlx-community", "ggml-org", "ggerganov", "second-state", "ollama",
  "library", "local", "noctrex", "mungert", "gabriellarson", "nexaai", "lm-kit", "tensorblock",
  "bullerwins", "dranger003", "legraphista", "featherless-ai", "huggingquants", "mmnga", "akjindal53244",
]);

const IMAGE_TYPE: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp", "image/svg+xml": "svg", "image/gif": "gif",
};
const EXT_TYPE: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml", gif: "image/gif" };

type Logo = { bytes: Buffer; contentType: string; ext: string };
type Entry = { file?: string; contentType?: string; fetchedAt: number; missing?: true };

// ---- configuration (read per call) ----

const enabled = () => process.env.OMNICHAT_MODEL_LOGOS !== "0";
const hfBase = () => (process.env.OMNICHAT_HF_BASE || "https://huggingface.co").trim().replace(/\/+$/, "");
const cdnAllow = () => (process.env.OMNICHAT_HF_CDN_ALLOW ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const isRepackager = (org: string) => REPACKAGERS.has(org.toLowerCase());

/** Only https to huggingface.co / hf.co (and subdomains), or an exact host[:port] from OMNICHAT_HF_CDN_ALLOW (tests). */
export function isAllowedAvatarUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (cdnAllow().some((e) => e === u.host.toLowerCase() || e === host)) return u.protocol === "http:" || u.protocol === "https:";
  if (u.protocol !== "https:" || u.port !== "") return false;
  return host === "huggingface.co" || host === "hf.co" || host.endsWith(".huggingface.co") || host.endsWith(".hf.co");
}

// ---- origin resolution ----

/** Name cleaned for search: last path segment, lowercased, quantization and format tokens removed. */
function cleanName(bare: string): string {
  const drop = /^(gguf|mlx|qat|it|uncensored|abliterated|bf16|fp16|fp8|f16|f32|int4|int8|\d+bit|q\d\w*|iq\d\w*)$/;
  return bare.toLowerCase().split(/[-\s]+/).filter((t) => t && !drop.test(t)).join("-");
}

/** Resolution that needs no network: family table, then publisher, then the id's org prefix. */
function localOrg(model: string, publisher?: string): string | null {
  const id = model.trim();
  const slash = id.indexOf("/");
  const bare = (slash >= 0 ? id.slice(id.lastIndexOf("/") + 1) : id).toLowerCase();
  for (const [re, org] of FAMILY) if (re.test(bare)) return org;
  const pub = publisher?.trim();
  if (pub && ORG_RE.test(pub) && !isRepackager(pub)) return pub;
  if (slash > 0) {
    const prefix = id.slice(0, slash);
    if (ORG_RE.test(prefix) && !isRepackager(prefix)) return prefix;
  }
  return null;
}

async function hfGet(url: string): Promise<{ status: number; json: any } | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { status: res.status, json: null };
    }
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch { return null; }
}

async function hfJson(url: string): Promise<any> {
  const r = await hfGet(url);
  return r?.status === 200 ? r.json : null;
}

/** Search Hugging Face for the model's repo, then take its base_model org, else its author. */
async function searchOrg(model: string): Promise<string | null> {
  const id = model.trim();
  const cleaned = cleanName(id.slice(id.lastIndexOf("/") + 1));
  if (!cleaned) return null;
  const base = hfBase();
  const found = await hfJson(`${base}/api/models?search=${encodeURIComponent(cleaned)}&limit=5`);
  if (!Array.isArray(found)) return null;
  const repos = found.map((r: any) => r?.id).filter((x: unknown): x is string => typeof x === "string" && REPO_RE.test(x));
  if (!repos.length) return null;
  const best = repos.find((r) => r.slice(r.indexOf("/") + 1).toLowerCase() === cleaned) ?? repos[0];
  const card = await hfJson(`${base}/api/models/${best}`);
  const bm = card?.cardData?.base_model;
  const first = Array.isArray(bm) ? bm[0] : bm;
  if (typeof first === "string" && first.includes("/")) {
    const org = first.trim().split("/")[0];
    if (ORG_RE.test(org) && !isRepackager(org)) return org;
  }
  const author = best.split("/")[0];
  return isRepackager(author) ? null : author;
}

const resolved = new Map<string, { org: string | null; at: number }>();
const resolving = new Map<string, Promise<string | null>>();

/** Hugging Face organization for a model, or null. Results of the search step are cached in memory for 24 h. */
export async function resolveOrg(model: string, publisher?: string): Promise<string | null> {
  const local = localOrg(model, publisher);
  if (local) return local;
  const key = `${model}|${publisher ?? ""}`;
  const hit = resolved.get(key);
  if (hit && Date.now() - hit.at < DAY) return hit.org;
  if (!enabled()) return null;
  let p = resolving.get(key);
  if (!p) {
    p = searchOrg(model)
      .catch(() => null)
      .then((org) => { resolved.set(key, { org, at: Date.now() }); return org; })
      .finally(() => resolving.delete(key));
    resolving.set(key, p);
  }
  return p;
}

// ---- avatar download ----

/** Downloads an avatar image, following at most 3 redirects; each hop must pass isAllowedAvatarUrl. */
async function fetchAvatarBytes(url: string, hops: number): Promise<Logo | null> {
  if (!isAllowedAvatarUrl(url)) return null;
  let res: Response;
  try {
    res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  } catch { return null; }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {});
    const loc = res.headers.get("location");
    if (!loc || hops >= MAX_HOPS) return null;
    let next: string;
    try { next = new URL(loc, url).href; } catch { return null; }
    return fetchAvatarBytes(next, hops + 1);
  }
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const ext = IMAGE_TYPE[type];
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (!res.ok || !ext || (Number.isFinite(declared) && declared > MAX_BYTES)) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      total += value.byteLength;
      if (total > MAX_BYTES) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
  } catch { return null; }
  if (!total) return null;
  return { bytes: Buffer.concat(chunks), contentType: type, ext };
}

async function fetchOrgAvatar(org: string): Promise<Logo | null> {
  const base = hfBase();
  const first = await hfGet(`${base}/api/organizations/${org}/avatar`);
  if (!first) return null;
  let avatar: unknown = null;
  if (first.status === 200) avatar = first.json?.avatarUrl;
  else if (first.status === 404) {
    const user = await hfGet(`${base}/api/users/${org}/avatar`);
    if (user?.status === 200) avatar = user.json?.avatarUrl;
  }
  if (typeof avatar !== "string" || !avatar) return null;
  let abs: string;
  try { abs = new URL(avatar, `${base}/`).href; } catch { return null; }
  return fetchAvatarBytes(abs, 0);
}

// ---- disk cache ----

let index: Record<string, Entry> | null = null;
const cacheDir = () => join(DATA_DIR, "cache", "model-logos");
const indexPath = () => join(cacheDir(), "index.json");

function loadIndex(): Record<string, Entry> {
  if (index) return index;
  try {
    const parsed = JSON.parse(readFileSync(indexPath(), "utf8"));
    index = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { index = {}; }
  return index!;
}

function saveIndex(): void {
  const tmp = `${indexPath()}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(tmp, JSON.stringify(loadIndex()));
    renameSync(tmp, indexPath());
  } catch {
    try { unlinkSync(tmp); } catch { /* */ }
  }
}

function readStored(e: Entry | undefined): Logo | null {
  if (!e || e.missing || !e.file || !FILE_RE.test(e.file)) return null;
  try {
    const ext = e.file.slice(e.file.lastIndexOf(".") + 1);
    return { bytes: readFileSync(join(cacheDir(), e.file)), contentType: e.contentType || EXT_TYPE[ext], ext };
  } catch { return null; }
}

function storeLogo(org: string, logo: Logo): Entry | null {
  const dir = cacheDir();
  const file = `${org}.${logo.ext}`;
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `${file}.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmp, logo.bytes);
    renameSync(tmp, join(dir, file));
  } catch { return null; }
  const prev = loadIndex()[org]?.file;
  if (prev && prev !== file && FILE_RE.test(prev)) { try { unlinkSync(join(dir, prev)); } catch { /* */ } }
  return { file, contentType: logo.contentType, fetchedAt: Date.now() };
}

// ---- per-organization logo ----

const failedAt = new Map<string, number>();
const refreshing = new Map<string, Promise<Logo | null>>();

async function refresh(org: string, prev: Entry | undefined): Promise<Logo | null> {
  const got = await fetchOrgAvatar(org).catch(() => null);
  const now = Date.now();
  if (got) {
    const entry = storeLogo(org, got);
    if (entry) { loadIndex()[org] = entry; saveIndex(); }
    failedAt.delete(org);
    return got;
  }
  if (prev && !prev.missing) {
    // Keep serving the stale file; do not retry upstream for 24 h.
    failedAt.set(org, now);
    return readStored(prev);
  }
  loadIndex()[org] = { fetchedAt: now, missing: true };
  saveIndex();
  return null;
}

async function logoFor(org: string): Promise<Logo | null> {
  if (!ORG_RE.test(org)) return null;
  const now = Date.now();
  const e = loadIndex()[org];
  if (e && !e.missing && now - e.fetchedAt < POS_TTL) {
    const hit = readStored(e);
    if (hit) return hit;
  }
  if (e?.missing && now - e.fetchedAt < NEG_TTL) return null;
  const stale = readStored(e);
  if (!enabled()) return stale;
  const f = failedAt.get(org);
  if (stale && f !== undefined && now - f < NEG_TTL) return stale;
  let p = refreshing.get(org);
  if (!p) {
    p = refresh(org, e).finally(() => refreshing.delete(org));
    refreshing.set(org, p);
  }
  return p;
}

/** Logo bytes for a model, or null when no organization or no avatar is known. */
export async function getModelLogo(model: string, publisher?: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  const org = await resolveOrg(model, publisher);
  if (!org) return null;
  const logo = await logoFor(org);
  return logo ? { bytes: logo.bytes, contentType: logo.contentType } : null;
}
