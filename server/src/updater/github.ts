// GitHub Releases client for the update system (node built-ins + global fetch only).
// Security rules: https only (http only for a loopback apiBase when allowHttp), a host allowlist for
// every redirect hop, the token is sent only to the first hop and only to the apiBase host, and the
// token never appears in an error message.
import { open, rename, rm } from "node:fs/promises";
import type { Channel, PluginInfo, ReleaseAsset, ReleaseInfo, UpdateErrorCode } from "./types.js";
import { compareVersions, parseVersion } from "./semver.js";

export class UpdateErr extends Error {
  readonly code: UpdateErrorCode;
  readonly status?: number;
  readonly resetAt?: number;

  constructor(code: UpdateErrorCode, message: string, extra: { status?: number; resetAt?: number } = {}) {
    super(message);
    this.name = "UpdateErr";
    this.code = code;
    this.status = extra.status;
    this.resetAt = extra.resetAt;
  }
}

const API_TIMEOUT_MS = 15_000;
const STALL_TIMEOUT_MS = 60_000; // abort a download that makes no progress for this long
const DEFAULT_MAX_BYTES = 600 * 1024 * 1024;
const DEFAULT_TEXT_MAX_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;
const NOTES_MAX = 20_000;
const DEFAULT_USER_AGENT = "omnichat-updater";
const PUBLIC_HOSTS = new Set(["github.com", "api.github.com"]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PLUGIN_RE = /^omnichat-dsh-bridge-(.+)\.tgz$/;
const SERVER_BUNDLE_PREFIX = "omnichat-server-bundle-";

export interface GithubClientOptions {
  apiBase: string;
  repo: string;
  token?: string;
  allowHttp?: boolean;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

export interface ListResult {
  releases: ReleaseInfo[];
  etag: string | null;
  notModified: boolean;
}

export interface DownloadOptions {
  onProgress?: (fraction: number) => void;
  maxBytes?: number;
  signal?: AbortSignal;
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function causeSuffix(e: unknown): string {
  const code = (e as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" ? ` (${code})` : "";
}

async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // ignore: the body is discarded either way
  }
}

function toAsset(raw: unknown): ReleaseAsset | null {
  if (!isObj(raw)) return null;
  const id = typeof raw.id === "number" ? raw.id : null;
  const name = str(raw.name);
  const url = str(raw.url);
  const downloadUrl = str(raw.browser_download_url);
  if (id === null || !name || !url || !downloadUrl) return null;
  return { id, name, size: typeof raw.size === "number" ? raw.size : 0, url, downloadUrl };
}

function toRelease(raw: unknown): ReleaseInfo | null {
  if (!isObj(raw)) return null;
  if (raw.draft === true) return null; // drafts are never offered
  const tag = str(raw.tag_name);
  if (!tag || !parseVersion(tag)) return null; // tags that are not semver are ignored
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  const body = str(raw.body) ?? "";
  const assets = Array.isArray(raw.assets)
    ? raw.assets.map(toAsset).filter((a): a is ReleaseAsset => a !== null)
    : [];
  return {
    tag,
    version,
    name: str(raw.name) || tag,
    notes: body.length > NOTES_MAX ? body.slice(0, NOTES_MAX) : body,
    prerelease: raw.prerelease === true,
    publishedAt: str(raw.published_at) ?? str(raw.created_at) ?? "",
    htmlUrl: str(raw.html_url) ?? "",
    assets,
  };
}

/** Picks the newest release for a channel. Stable excludes prereleases; the prerelease channel sees everything. */
export function pickLatest(releases: ReleaseInfo[], channel: Channel): ReleaseInfo | null {
  let best: ReleaseInfo | null = null;
  for (const r of releases) {
    const v = parseVersion(r.version);
    if (!v) continue;
    if (channel === "stable" && (r.prerelease || v.pre.length > 0)) continue;
    if (!best || compareVersions(r.version, best.version) > 0) best = r;
  }
  return best;
}

/** The platform-independent server bundle zip for this release, or null. */
export function findServerBundle(r: ReleaseInfo): ReleaseAsset | null {
  const name = `${SERVER_BUNDLE_PREFIX}${r.version}.zip`;
  return r.assets.find((a) => a.name === name) ?? null;
}

/** The newest omnichat-dsh-bridge tgz in this release, or null. */
export function findPlugin(r: ReleaseInfo): PluginInfo | null {
  let best: PluginInfo | null = null;
  for (const a of r.assets) {
    const m = PLUGIN_RE.exec(a.name);
    if (!m) continue;
    const version = m[1].replace(/^v/, "");
    if (!parseVersion(version)) continue;
    if (!best || compareVersions(version, best.version) > 0) {
      best = { version, assetName: a.name, downloadUrl: a.downloadUrl };
    }
  }
  return best;
}

/** Checksum assets that may cover `assetName`: a combined SHA256SUMS and/or `<assetName>.sha256`. */
export function findChecksumAssets(
  r: ReleaseInfo,
  assetName: string,
): { sums: ReleaseAsset | null; per: ReleaseAsset | null } {
  return {
    sums: r.assets.find((a) => a.name === "SHA256SUMS") ?? null,
    per: r.assets.find((a) => a.name === `${assetName}.sha256`) ?? null,
  };
}

export class GithubClient {
  private readonly apiBase: string;
  private readonly repo: string;
  private readonly token: string | undefined;
  private readonly allowHttp: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(opts: GithubClientOptions) {
    this.apiBase = opts.apiBase.replace(/\/+$/, "");
    this.repo = opts.repo;
    this.token = opts.token ? opts.token : undefined;
    this.allowHttp = opts.allowHttp === true;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  }

  /** GET releases of the repo. Pass prev (etag + cached releases) for a conditional request. */
  async listReleases(prev?: { etag: string; releases: ReleaseInfo[] }): Promise<ListResult> {
    const url = this.checkUrl(this.repoUrl("/releases?per_page=30"));
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": this.userAgent,
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (prev?.etag) headers["If-None-Match"] = prev.etag;
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    return this.withTimeout(API_TIMEOUT_MS, async (signal) => {
      const res = await this.fetchImpl(url, { headers, redirect: "manual", signal });
      const etag = res.headers.get("etag");

      if (res.status === 304) {
        await drain(res);
        if (!prev) throw new UpdateErr("bad-response", "GitHub sent 304 without a cached listing");
        return { releases: prev.releases, etag: etag ?? prev.etag, notModified: true };
      }
      if (res.status !== 200) {
        await drain(res);
        throw this.httpError(res);
      }

      const text = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new UpdateErr("bad-response", "GitHub returned a non-JSON release listing");
      }
      if (!Array.isArray(body)) throw new UpdateErr("bad-response", "unexpected release listing shape");
      const releases = body.map(toRelease).filter((r): r is ReleaseInfo => r !== null);
      return { releases, etag, notModified: false };
    });
  }

  /** Downloads an asset to destFile (through destFile + ".part", renamed on success). */
  async downloadAsset(asset: ReleaseAsset, destFile: string, opts: DownloadOptions = {}): Promise<void> {
    const max = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const part = `${destFile}.part`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(part, "w");
      const fh = handle;
      await this.streamAsset(
        asset,
        max,
        async (chunk) => {
          try {
            await fh.write(chunk);
          } catch (e) {
            throw new UpdateErr("download", `write failed: ${errMsg(e)}`);
          }
        },
        opts,
      );
      await handle.close();
      handle = undefined;
      await rename(part, destFile);
    } catch (e) {
      if (handle) await handle.close().catch(() => undefined);
      await rm(part, { force: true }).catch(() => undefined);
      if (e instanceof UpdateErr) throw e;
      throw new UpdateErr("download", `download failed: ${errMsg(e)}`);
    }
  }

  /** Downloads a small asset (e.g. SHA256SUMS) as UTF-8 text, capped at maxBytes. */
  async fetchAssetText(asset: ReleaseAsset, maxBytes: number = DEFAULT_TEXT_MAX_BYTES): Promise<string> {
    const chunks: Buffer[] = [];
    await this.streamAsset(asset, maxBytes, async (chunk) => {
      chunks.push(chunk);
    }, {});
    return Buffer.concat(chunks).toString("utf8");
  }

  // ---- internals -------------------------------------------------------------------------------

  private repoUrl(suffix: string): string {
    if (!REPO_RE.test(this.repo)) throw new UpdateErr("other", "invalid repository name");
    return `${this.apiBase}/repos/${this.repo}${suffix}`;
  }

  private apiHostname(): string | null {
    try {
      return new URL(this.apiBase).hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  /** Validates a URL before any request. Throws UpdateErr("unsupported") when it is not allowed. */
  private checkUrl(raw: string | URL): URL {
    let u: URL;
    try {
      u = raw instanceof URL ? raw : new URL(raw);
    } catch {
      throw new UpdateErr("unsupported", "refusing a malformed URL");
    }
    if (u.username || u.password) throw new UpdateErr("unsupported", "refusing a URL with credentials");
    const host = u.hostname.toLowerCase();
    const apiHost = this.apiHostname();
    const httpOk =
      this.allowHttp && apiHost !== null && LOOPBACK.has(apiHost) && LOOPBACK.has(host);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && httpOk)) {
      throw new UpdateErr("unsupported", `refusing non-https URL (${u.protocol.replace(":", "")})`);
    }
    const allowed =
      host === apiHost ||
      PUBLIC_HOSTS.has(host) ||
      host === "githubusercontent.com" ||
      host.endsWith(".githubusercontent.com");
    if (!allowed) throw new UpdateErr("unsupported", `refusing download from host ${host}`);
    return u;
  }

  /** Replaces the token with a placeholder in any text that may carry it. */
  private redact(s: string): string {
    return this.token ? s.split(this.token).join("[redacted]") : s;
  }

  private httpError(res: Response): UpdateErr {
    const status = res.status;
    if (status === 401) {
      return new UpdateErr("unauthorized", "GitHub rejected the token (401): check the GitHub token in settings", {
        status,
      });
    }
    if (status === 403 || status === 429) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      const retryAfter = res.headers.get("retry-after");
      if (remaining === "0" || retryAfter !== null || status === 429) {
        let resetAt: number | undefined;
        const reset = Number(res.headers.get("x-ratelimit-reset"));
        const retry = Number(retryAfter);
        if (Number.isFinite(reset) && reset > 0) resetAt = reset * 1000;
        else if (retryAfter !== null && Number.isFinite(retry)) resetAt = Date.now() + retry * 1000;
        return new UpdateErr("rate-limited", "GitHub API rate limit reached; try again later", {
          status,
          resetAt,
        });
      }
      return new UpdateErr("forbidden", "GitHub refused access (403): check the token permissions", { status });
    }
    if (status === 404) {
      return new UpdateErr(
        "not-found",
        "repository or release not found: the repo is missing or private, set a GitHub token in settings",
        { status },
      );
    }
    return new UpdateErr("bad-response", `GitHub returned HTTP ${status}`, { status });
  }

  /** Runs fn under a single overall timeout; maps unexpected failures to "network". */
  private async withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      return await fn(ctl.signal);
    } catch (e) {
      if (e instanceof UpdateErr) throw e;
      if (ctl.signal.aborted) throw new UpdateErr("network", "GitHub request timed out");
      throw new UpdateErr("network", this.redact(`network error${causeSuffix(e)}: ${errMsg(e)}`));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Streams an asset through the sink. Follows redirects manually (max 5), validating every hop.
   * The Authorization header goes only on the first hop, and only when it targets the apiBase host.
   */
  private async streamAsset(
    asset: ReleaseAsset,
    maxBytes: number,
    sink: (chunk: Buffer) => Promise<void>,
    opts: DownloadOptions,
  ): Promise<void> {
    if (asset.size > maxBytes) {
      throw new UpdateErr("download", `asset is larger than the ${maxBytes}-byte limit`);
    }
    if (opts.signal?.aborted) throw new UpdateErr("download", "download cancelled");

    const ctl = new AbortController();
    const abort = () => ctl.abort();
    opts.signal?.addEventListener("abort", abort, { once: true });
    let idle: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(abort, STALL_TIMEOUT_MS);
    };
    arm();

    try {
      const useApi = this.token !== undefined;
      let current = this.checkUrl(useApi ? asset.url : asset.downloadUrl);
      const apiHost = this.apiHostname();

      for (let hop = 0; ; hop++) {
        const headers: Record<string, string> = {
          Accept: "application/octet-stream",
          "User-Agent": this.userAgent,
        };
        if (hop === 0 && this.token && current.hostname.toLowerCase() === apiHost) {
          headers.Authorization = `Bearer ${this.token}`;
        }
        const res = await this.fetchImpl(current, { headers, redirect: "manual", signal: ctl.signal });

        if (res.status >= 300 && res.status < 400) {
          await drain(res);
          const location = res.headers.get("location");
          if (!location) throw new UpdateErr("download", "redirect without a location");
          if (hop >= MAX_REDIRECTS) throw new UpdateErr("download", "too many redirects");
          let next: URL;
          try {
            next = new URL(location, current);
          } catch {
            throw new UpdateErr("unsupported", "refusing a malformed redirect URL");
          }
          current = this.checkUrl(next);
          arm();
          continue;
        }

        if (res.status !== 200) {
          await drain(res);
          if (res.status === 401) throw new UpdateErr("unauthorized", "GitHub rejected the token (401)", { status: 401 });
          if (res.status === 404) throw new UpdateErr("not-found", "release asset not found", { status: 404 });
          throw new UpdateErr("download", `download failed (HTTP ${res.status})`, { status: res.status });
        }

        const cl = res.headers.get("content-length");
        const clNum = cl === null ? NaN : Number(cl);
        if (Number.isFinite(clNum)) {
          if (clNum > maxBytes) throw new UpdateErr("download", `asset exceeds the ${maxBytes}-byte limit`);
          if (asset.size > 0 && clNum !== asset.size) {
            throw new UpdateErr("download", "content-length does not match the release metadata");
          }
        }
        if (!res.body) return;

        const total = asset.size > 0 ? asset.size : Number.isFinite(clNum) ? clNum : 0;
        const reader = res.body.getReader();
        let got = 0;
        for (;;) {
          arm();
          const { done, value } = await reader.read();
          if (done) break;
          got += value.byteLength;
          if (got > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new UpdateErr("download", `asset exceeds the ${maxBytes}-byte limit`);
          }
          await sink(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
          if (total > 0) opts.onProgress?.(Math.min(1, got / total));
        }
        if (asset.size > 0 && got !== asset.size) {
          throw new UpdateErr("download", "downloaded size does not match the release metadata");
        }
        opts.onProgress?.(1);
        return;
      }
    } catch (e) {
      if (e instanceof UpdateErr) throw e;
      if (ctl.signal.aborted) {
        throw new UpdateErr("download", opts.signal?.aborted ? "download cancelled" : "download stalled or aborted");
      }
      throw new UpdateErr("network", this.redact(`download network error${causeSuffix(e)}: ${errMsg(e)}`));
    } finally {
      if (idle) clearTimeout(idle);
      opts.signal?.removeEventListener("abort", abort);
    }
  }
}
