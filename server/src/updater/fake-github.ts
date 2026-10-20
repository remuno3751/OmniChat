// Local fake of the GitHub Releases API for tests and e2e runs. Binds 127.0.0.1 only.
//
// Library: startFakeGithub({port?, token?}) -> {base, setReleases, hits, setRateLimit, stop}
//          GET /assets/:id -> 302 to /dl/<name>?id=<id> (needs the token when one is configured)
// CLI:     node --import tsx src/updater/fake-github.ts --port 8819 --dir <dir> [--token <t>]
//          <dir>/releases.json = [{tag, prerelease?, draft?, body?, withSums?,
//                                   assets: [{name, file}]}]   (file is relative to <dir>)
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface FakeAsset {
  name: string;
  data: Buffer | string;
}

export interface FakeRelease {
  tag: string;
  prerelease?: boolean;
  draft?: boolean;
  body?: string;
  assets: FakeAsset[];
  /**
   * Checksum assets to generate: "sums" (SHA256SUMS, default), "per-asset" (<name>.sha256),
   * "none", or "wrong" (both kinds with bad hashes).
   */
  withSums?: "sums" | "per-asset" | "none" | "wrong";
}

export interface FakeHits {
  /** Every request served. */
  total: number;
  /** Release listing requests. */
  releases: number;
  /** Listing requests answered with 304. */
  notModified: number;
  /** Asset requests (API asset url and /dl). */
  assets: number;
  /** "METHOD /path status" lines, newest last. Never contains the token. */
  log: string[];
}

export interface FakeGithub {
  base: string;
  setReleases(rs: FakeRelease[]): void;
  hits: FakeHits;
  setRateLimit(on: boolean): void;
  stop(): Promise<void>;
}

interface StoredAsset {
  id: number;
  name: string;
  data: Buffer;
}

interface StoredRelease {
  id: number;
  tag: string;
  prerelease: boolean;
  draft: boolean;
  body: string;
  publishedAt: string;
  assets: StoredAsset[];
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function startFakeGithub(opts: { port?: number; token?: string } = {}): Promise<FakeGithub> {
  const token = opts.token;
  const hits: FakeHits = { total: 0, releases: 0, notModified: 0, assets: 0, log: [] };
  let releases: StoredRelease[] = [];
  let rateLimit = false;
  let nextId = 1000;
  let base = "";

  function build(rs: FakeRelease[]): StoredRelease[] {
    return rs.map((r) => {
      const release: StoredRelease = {
        id: nextId++,
        tag: r.tag,
        prerelease: r.prerelease === true,
        draft: r.draft === true,
        body: r.body ?? "",
        publishedAt: new Date().toISOString(),
        assets: [],
      };
      for (const a of r.assets) {
        release.assets.push({
          id: nextId++,
          name: a.name,
          data: Buffer.isBuffer(a.data) ? a.data : Buffer.from(a.data, "utf8"),
        });
      }
      const mode = r.withSums ?? "sums";
      const bad = (data: Buffer) => sha256Hex(Buffer.concat([Buffer.from("tampered:"), data]));
      const originals = release.assets.slice(); // checksum files cover only the real assets
      if (mode === "sums" || mode === "wrong") {
        const lines = originals
          .map((a) => `${mode === "wrong" ? bad(a.data) : sha256Hex(a.data)}  ${a.name}`)
          .join("\n");
        release.assets.push({ id: nextId++, name: "SHA256SUMS", data: Buffer.from(lines + "\n") });
      }
      if (mode === "per-asset" || mode === "wrong") {
        for (const a of originals) {
          const hex = mode === "wrong" ? bad(a.data) : sha256Hex(a.data);
          release.assets.push({
            id: nextId++,
            name: `${a.name}.sha256`,
            data: Buffer.from(`${hex}  ${a.name}\n`),
          });
        }
      }
      return release;
    });
  }

  /** Browser download url: /dl/<name>?id=<id>. The id keeps duplicate names (SHA256SUMS) apart. */
  function downloadPath(a: StoredAsset): string {
    return `${base}/dl/${encodeURIComponent(a.name)}?id=${a.id}`;
  }

  function releaseJson(r: StoredRelease): Record<string, unknown> {
    return {
      id: r.id,
      tag_name: r.tag,
      name: r.tag,
      body: r.body,
      draft: r.draft,
      prerelease: r.prerelease,
      published_at: r.publishedAt,
      html_url: `${base}/releases/tag/${encodeURIComponent(r.tag)}`,
      assets: r.assets.map((a) => ({
        id: a.id,
        name: a.name,
        size: a.data.length,
        content_type: "application/octet-stream",
        url: `${base}/assets/${a.id}`,
        browser_download_url: downloadPath(a),
      })),
    };
  }

  function findAssetById(id: number): StoredAsset | null {
    for (const r of releases) {
      const a = r.assets.find((x) => x.id === id);
      if (a) return a;
    }
    return null;
  }

  /** Looks up by asset id when given (names such as SHA256SUMS repeat across releases), else by name. */
  function findAssetByName(name: string, id: number | null): StoredAsset | null {
    for (const r of releases) {
      const a = r.assets.find((x) => (id !== null ? x.id === id : x.name === name));
      if (a) return a;
    }
    return null;
  }

  function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(text);
  }

  /** Returns false (and writes a response) when the request is not authorized. */
  function authorized(req: IncomingMessage, res: ServerResponse): boolean {
    if (!token) return true;
    const h = req.headers.authorization;
    if (!h) {
      // Like GitHub for private repos: without credentials the repo looks missing.
      sendJson(res, 404, { message: "Not Found" });
      return false;
    }
    if (h !== `Bearer ${token}`) {
      sendJson(res, 401, { message: "Bad credentials" });
      return false;
    }
    return true;
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    hits.total++;
    const finish = () => hits.log.push(`${req.method} ${path} ${res.statusCode}`);
    res.on("finish", finish);

    if (req.method !== "GET") {
      sendJson(res, 405, { message: "Method Not Allowed" });
      return;
    }

    // Release listing: /repos/:owner/:repo/releases
    if (/^\/repos\/[^/]+\/[^/]+\/releases$/.test(path)) {
      hits.releases++;
      if (rateLimit) {
        const reset = Math.floor(Date.now() / 1000) + 3600;
        sendJson(
          res,
          403,
          { message: "API rate limit exceeded" },
          { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
        );
        return;
      }
      if (!authorized(req, res)) return;
      const body = JSON.stringify(releases.map(releaseJson));
      const etag = `"${sha256Hex(body).slice(0, 32)}"`;
      if (req.headers["if-none-match"] === etag) {
        hits.notModified++;
        res.writeHead(304, { etag });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json", etag });
      res.end(body);
      return;
    }

    // API asset url: /assets/:id -> redirect to /dl/<name> (like GitHub's redirect to its CDN).
    const assetMatch = /^\/assets\/(\d+)$/.exec(path);
    if (assetMatch) {
      hits.assets++;
      if (!authorized(req, res)) return;
      const asset = findAssetById(Number(assetMatch[1]));
      if (!asset) {
        sendJson(res, 404, { message: "Not Found" });
        return;
      }
      res.writeHead(302, { location: downloadPath(asset) });
      res.end();
      return;
    }

    // Browser download url: /dl/<name> (no auth, like public release downloads).
    if (path.startsWith("/dl/")) {
      hits.assets++;
      const name = decodeURIComponent(path.slice("/dl/".length));
      const idParam = url.searchParams.get("id");
      const asset = findAssetByName(name, idParam !== null ? Number(idParam) : null);
      if (!asset) {
        sendJson(res, 404, { message: "Not Found" });
        return;
      }
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(asset.data.length),
      });
      res.end(asset.data);
      return;
    }

    sendJson(res, 404, { message: "Not Found" });
  }

  const server: Server = createServer(handle);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;

  let stopped = false;
  return {
    base,
    hits,
    setReleases(rs: FakeRelease[]) {
      releases = build(rs);
    },
    setRateLimit(on: boolean) {
      rateLimit = on;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections();
      });
    },
  };
}

// ---- CLI ---------------------------------------------------------------------------------------

interface CliEntry {
  tag: string;
  prerelease?: boolean;
  draft?: boolean;
  body?: string;
  withSums?: FakeRelease["withSums"];
  assets: { name: string; file: string }[];
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function runCli(args: string[]): Promise<void> {
  const dir = resolve(argValue(args, "--dir") ?? ".");
  const port = Number(argValue(args, "--port") ?? "0");
  const token = argValue(args, "--token");
  const entries = JSON.parse(readFileSync(resolve(dir, "releases.json"), "utf8")) as CliEntry[];
  const rs: FakeRelease[] = entries.map((e) => ({
    tag: e.tag,
    prerelease: e.prerelease,
    draft: e.draft,
    body: e.body,
    withSums: e.withSums,
    assets: e.assets.map((a) => ({ name: a.name, data: readFileSync(resolve(dir, a.file)) })),
  }));
  const fake = await startFakeGithub({ port, token });
  fake.setReleases(rs);
  console.log(`fake github listening at ${fake.base}`);
  const shutdown = () => {
    void fake.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  runCli(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
