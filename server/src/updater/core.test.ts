// Tests for the pure update core: semver, checksums, GitHub client (against startFakeGithub) and asset helpers.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareVersions, gt, isPrerelease, parseVersion } from "./semver.js";
import { parseSums, sha256File, sumFor, verifySha256 } from "./checksums.js";
import {
  GithubClient,
  UpdateErr,
  findChecksumAssets,
  findPlugin,
  findServerBundle,
  pickLatest,
} from "./github.js";
import { startFakeGithub, type FakeGithub, type FakeRelease } from "./fake-github.js";
import type { ReleaseAsset, ReleaseInfo } from "./types.js";

const HEX_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"; // sha256("abc")
const TOKEN = "ghp_unit_test_token_0001";
const REPO = "remuno3751/omnichat";
const BUNDLE_120 = Buffer.from("PK\u0003\u0004 fake server bundle 1.2.0 ".repeat(500));
const PLUGIN_030 = Buffer.from("fake plugin tgz 0.3.0");
const BUNDLE_120_NAME = "omnichat-server-bundle-1.2.0.zip";

const RELEASES: FakeRelease[] = [
  {
    tag: "v1.2.0",
    assets: [
      { name: BUNDLE_120_NAME, data: BUNDLE_120 },
      { name: "omnichat-dsh-bridge-0.3.0.tgz", data: PLUGIN_030 },
    ],
  },
  {
    tag: "v1.3.0-rc.1",
    prerelease: true,
    withSums: "per-asset",
    assets: [{ name: "omnichat-server-bundle-1.3.0-rc.1.zip", data: "rc bundle" }],
  },
  { tag: "v1.3.0", draft: true, assets: [] }, // drafts must never be listed
  { tag: "nightly-2026-10-01", assets: [] }, // not semver: dropped
  {
    tag: "v1.1.0",
    withSums: "wrong",
    assets: [{ name: "omnichat-server-bundle-1.1.0.zip", data: "old bundle" }],
  },
];

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function release(version: string, extra: Partial<ReleaseInfo> = {}): ReleaseInfo {
  return {
    tag: `v${version}`,
    version,
    name: `v${version}`,
    notes: "",
    prerelease: false,
    publishedAt: "",
    htmlUrl: "",
    assets: [],
    ...extra,
  };
}

function assetNamed(name: string): ReleaseAsset {
  return {
    id: 1,
    name,
    size: 1,
    url: "https://api.github.com/repos/x/y/releases/assets/1",
    downloadUrl: `https://github.com/x/y/releases/download/v1/${name}`,
  };
}

type Call = { url: string; auth: string | null };

/** A fetch wrapper that records every hop (URL + Authorization) and can force a response. */
function recordingFetch(calls: Call[], forced?: (url: string) => Response | null): typeof fetch {
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    const r = forced?.(url);
    if (r) return r;
    return fetch(input, init);
  };
  return impl as typeof fetch;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "omni-upd-core-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---- semver ------------------------------------------------------------------------------------

describe("semver", () => {
  test("prerelease precedence chain from the spec", () => {
    const chain = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-beta", "1.0.0-rc.1", "1.0.0"];
    for (let i = 0; i < chain.length - 1; i++) {
      assert.equal(compareVersions(chain[i], chain[i + 1]), -1, `${chain[i]} < ${chain[i + 1]}`);
      assert.equal(compareVersions(chain[i + 1], chain[i]), 1, `${chain[i + 1]} > ${chain[i]}`);
    }
    assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  });

  test("numeric core is compared numerically, not as text", () => {
    assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
    assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
    assert.equal(compareVersions("1.0.10", "1.0.9"), 1);
  });

  test("numeric prerelease identifiers compare numerically and sort before alphanumeric ones", () => {
    assert.equal(compareVersions("1.0.0-alpha.9", "1.0.0-alpha.10"), -1);
    assert.equal(compareVersions("1.0.0-1", "1.0.0-alpha"), -1);
    assert.equal(compareVersions("1.0.0-alpha.beta", "1.0.0-alpha.1"), 1);
  });

  test("a leading v and build metadata are ignored", () => {
    assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
    assert.equal(compareVersions("1.0.0+build.5", "1.0.0"), 0);
    assert.equal(compareVersions("v1.0.0-rc.1+abc", "1.0.0-rc.1"), 0);
    assert.equal(parseVersion("v1.2.3+meta")?.patch, 3);
  });

  test("sorting a mixed list gives SemVer order", () => {
    const input = ["1.10.0", "1.0.0", "2.0.0-beta", "1.0.0-rc.1", "1.9.0", "1.0.0-alpha", "2.0.0"];
    const sorted = [...input].sort((a, b) => compareVersions(a, b));
    assert.deepEqual(sorted, ["1.0.0-alpha", "1.0.0-rc.1", "1.0.0", "1.9.0", "1.10.0", "2.0.0-beta", "2.0.0"]);
  });

  test("invalid versions parse to null and compare throws", () => {
    for (const bad of ["", "v", "1.0", "01.0.0", "1.0.0-", "1.0.0-01", "1.0.0-a..b", "1.0.0+", "latest"]) {
      assert.equal(parseVersion(bad), null, JSON.stringify(bad));
    }
    assert.throws(() => compareVersions("nope", "1.0.0"), /invalid version/);
    assert.throws(() => gt("1.0.0", "x"));
    assert.throws(() => isPrerelease("bogus"));
  });

  test("gt and isPrerelease", () => {
    assert.equal(gt("1.0.1", "1.0.0"), true);
    assert.equal(gt("1.0.0-rc.1", "1.0.0"), false);
    assert.equal(gt("1.0.0", "1.0.0"), false);
    assert.equal(isPrerelease("1.0.0-rc.1"), true);
    assert.equal(isPrerelease("v1.0.0"), false);
  });
});

// ---- checksums ---------------------------------------------------------------------------------

describe("checksums", () => {
  test("parseSums accepts sha256sum text and binary markers, CRLF, and skips junk", () => {
    const text = [
      `${HEX_ABC}  omnichat-server-bundle-1.0.0.zip`,
      `${HEX_ABC.toUpperCase()} *OmniChat-Setup.exe`,
      "",
      "# a comment",
      "not a checksum line",
      "abc123  too-short.zip",
      `${HEX_ABC}  ./dsh.tgz`,
    ].join("\r\n");
    const m = parseSums(text);
    assert.equal(m.size, 3);
    assert.equal(m.get("omnichat-server-bundle-1.0.0.zip"), HEX_ABC);
    assert.equal(m.get("OmniChat-Setup.exe"), HEX_ABC, "uppercase hex is lowercased, * marker removed");
    assert.equal(m.get("dsh.tgz"), HEX_ABC, "leading ./ removed");
  });

  test("sumFor prefers the combined list and falls back to per-asset files", () => {
    const sums = `${HEX_ABC}  a.zip\n`;
    assert.equal(sumFor("a.zip", sums, null), HEX_ABC);
    assert.equal(sumFor("b.zip", sums, null), null);
    assert.equal(sumFor("a.zip", null, HEX_ABC), HEX_ABC, "bare hex per-asset file");
    assert.equal(sumFor("a.zip", null, `${HEX_ABC}  a.zip\n`), HEX_ABC);
    assert.equal(sumFor("a.zip", null, `${HEX_ABC} *a.zip`), HEX_ABC);
    assert.equal(sumFor("a.zip", null, `${HEX_ABC}  other.zip`), null, "per-asset file names another asset");
    assert.equal(sumFor("a.zip", null, "not-a-hash"), null);
    assert.equal(sumFor("a.zip", null, null), null);
    assert.equal(sumFor("a.zip", `${"0".repeat(64)}  a.zip`, HEX_ABC), "0".repeat(64), "combined list wins");
  });

  test("sha256File hashes a file and verifySha256 rejects a mismatch", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "abc.bin");
      await writeFile(file, "abc");
      assert.equal(await sha256File(file), HEX_ABC);
      await verifySha256(file, HEX_ABC);
      await verifySha256(file, HEX_ABC.toUpperCase());
      await assert.rejects(verifySha256(file, "0".repeat(64)), (e: unknown) => {
        return e instanceof UpdateErr && e.code === "checksum-mismatch";
      });
    });
  });
});

// ---- github client against the fake server -----------------------------------------------------

describe("GithubClient against startFakeGithub", () => {
  let fake: FakeGithub;
  let client: GithubClient;

  before(async () => {
    fake = await startFakeGithub({ token: TOKEN });
    fake.setReleases(RELEASES);
    client = new GithubClient({ apiBase: fake.base, repo: REPO, token: TOKEN, allowHttp: true });
  });

  after(async () => {
    await fake.stop();
  });

  async function bundleAsset(): Promise<ReleaseAsset> {
    const { releases } = await client.listReleases();
    const rel = releases.find((r) => r.version === "1.2.0");
    const asset = rel ? findServerBundle(rel) : null;
    assert.ok(asset, "bundle asset for 1.2.0");
    return asset;
  }

  test("listReleases drops drafts and non-semver tags", async () => {
    const r = await client.listReleases();
    assert.deepEqual(
      r.releases.map((x) => x.version),
      ["1.2.0", "1.3.0-rc.1", "1.1.0"],
    );
    assert.equal(r.notModified, false);
    assert.equal(typeof r.etag, "string");
    const first = r.releases[0];
    assert.equal(first.tag, "v1.2.0");
    assert.equal(first.prerelease, false);
    assert.ok(first.assets.some((a) => a.name === BUNDLE_120_NAME));
  });

  test("pickLatest: stable excludes prereleases, prerelease channel sees them", async () => {
    const { releases } = await client.listReleases();
    assert.equal(pickLatest(releases, "stable")?.version, "1.2.0");
    assert.equal(pickLatest(releases, "prerelease")?.version, "1.3.0-rc.1");
    assert.equal(pickLatest([], "stable"), null);
    // A version with prerelease identifiers is excluded from stable even when the flag is false.
    const mixed = [release("2.0.0-rc.1"), release("1.0.0")];
    assert.equal(pickLatest(mixed, "stable")?.version, "1.0.0");
    assert.equal(pickLatest(mixed, "prerelease")?.version, "2.0.0-rc.1");
  });

  test("ETag round trip returns notModified with exactly one extra request", async () => {
    const first = await client.listReleases();
    const etag = first.etag ?? "";
    assert.notEqual(etag, "");
    const totalBefore = fake.hits.total;
    const notModifiedBefore = fake.hits.notModified;
    const second = await client.listReleases({ etag, releases: first.releases });
    assert.equal(second.notModified, true);
    assert.equal(second.etag, etag);
    assert.deepEqual(second.releases, first.releases);
    assert.equal(fake.hits.total - totalBefore, 1);
    assert.equal(fake.hits.notModified - notModifiedBefore, 1);
  });

  test("a wrong token gives unauthorized", async () => {
    const bad = new GithubClient({ apiBase: fake.base, repo: REPO, token: "wrong-token-value-xyz", allowHttp: true });
    await assert.rejects(bad.listReleases(), (e: unknown) => {
      return e instanceof UpdateErr && e.code === "unauthorized" && e.status === 401;
    });
  });

  test("no token against a private repo gives not-found mentioning the token", async () => {
    const anon = new GithubClient({ apiBase: fake.base, repo: REPO, allowHttp: true });
    await assert.rejects(anon.listReleases(), (e: unknown) => {
      return e instanceof UpdateErr && e.code === "not-found" && /token/i.test(e.message);
    });
  });

  test("rate limit gives rate-limited with resetAt", async () => {
    fake.setRateLimit(true);
    try {
      await assert.rejects(client.listReleases(), (e: unknown) => {
        return (
          e instanceof UpdateErr &&
          e.code === "rate-limited" &&
          typeof e.resetAt === "number" &&
          e.resetAt > Date.now()
        );
      });
    } finally {
      fake.setRateLimit(false);
    }
  });

  test("a stopped server gives network", async () => {
    const gone = await startFakeGithub();
    const goneBase = gone.base;
    await gone.stop();
    const c = new GithubClient({ apiBase: goneBase, repo: REPO, allowHttp: true });
    await assert.rejects(c.listReleases(), (e: unknown) => e instanceof UpdateErr && e.code === "network");
  });

  test("downloadAsset writes the file, reports progress and leaves no .part file", async () => {
    await withTempDir(async (dir) => {
      const asset = await bundleAsset();
      const dest = join(dir, asset.name);
      const progress: number[] = [];
      await client.downloadAsset(asset, dest, { onProgress: (f) => progress.push(f) });
      assert.ok((await readFile(dest)).equals(BUNDLE_120));
      assert.ok(progress.length >= 1);
      assert.equal(progress[progress.length - 1], 1);
      assert.ok(progress.every((p, i) => i === 0 || p >= progress[i - 1]), "progress is monotonic");
      assert.equal(existsSync(`${dest}.part`), false);
    });
  });

  test("the token goes only to the first hop, and the redirect hop has no Authorization", async () => {
    await withTempDir(async (dir) => {
      const asset = await bundleAsset();
      const calls: Call[] = [];
      const c = new GithubClient({
        apiBase: fake.base,
        repo: REPO,
        token: TOKEN,
        allowHttp: true,
        fetchImpl: recordingFetch(calls),
      });
      await c.downloadAsset(asset, join(dir, "bundle.zip"));
      assert.equal(calls.length, 2, "one API hop, one redirect hop");
      assert.equal(calls[0].auth, `Bearer ${TOKEN}`);
      assert.ok(calls[0].url.includes("/assets/"));
      assert.equal(calls[1].auth, null);
      assert.ok(calls[1].url.includes("/dl/"));
    });
  });

  test("a redirect to a non-allowlisted host is refused before any request", async () => {
    await withTempDir(async (dir) => {
      const asset = await bundleAsset();
      for (const location of ["https://evil.example.com/steal.zip", "http://downloads.example.org/x.zip"]) {
        const calls: Call[] = [];
        const evil = new GithubClient({
          apiBase: fake.base,
          repo: REPO,
          token: TOKEN,
          allowHttp: true,
          fetchImpl: recordingFetch(calls, (url) =>
            url.includes("/assets/") ? new Response(null, { status: 302, headers: { location } }) : null,
          ),
        });
        const dest = join(dir, "evil.zip");
        await assert.rejects(evil.downloadAsset(asset, dest), (e: unknown) => {
          return e instanceof UpdateErr && e.code === "unsupported";
        });
        assert.equal(calls.some((c) => c.url.includes("evil.example.com") || c.url.includes("downloads.example.org")), false);
        assert.equal(existsSync(dest), false);
      }
    });
  });

  test("https only: plain http apiBase without loopback is unsupported", async () => {
    const plain = new GithubClient({ apiBase: "http://github.example.com/api", repo: REPO });
    await assert.rejects(plain.listReleases(), (e: unknown) => e instanceof UpdateErr && e.code === "unsupported");
    const stillPlain = new GithubClient({ apiBase: "http://github.example.com/api", repo: REPO, allowHttp: true });
    await assert.rejects(stillPlain.listReleases(), (e: unknown) => e instanceof UpdateErr && e.code === "unsupported");
  });

  test("https only: an http asset url off loopback is refused for download", async () => {
    const c = new GithubClient({ apiBase: "https://api.github.com", repo: REPO });
    const asset: ReleaseAsset = {
      id: 7,
      name: "x.zip",
      size: 1,
      url: "http://objects.githubusercontent.com/x.zip",
      downloadUrl: "http://objects.githubusercontent.com/x.zip",
    };
    await withTempDir(async (dir) => {
      await assert.rejects(c.downloadAsset(asset, join(dir, "x.zip")), (e: unknown) => {
        return e instanceof UpdateErr && e.code === "unsupported";
      });
    });
  });

  test("maxBytes is enforced and a lying size is caught by Content-Length", async () => {
    await withTempDir(async (dir) => {
      const asset = await bundleAsset();
      const small = join(dir, "big.zip");
      await assert.rejects(client.downloadAsset(asset, small, { maxBytes: 100 }), (e: unknown) => {
        return e instanceof UpdateErr && e.code === "download";
      });
      assert.equal(existsSync(small), false);
      assert.equal(existsSync(`${small}.part`), false);

      const lying: ReleaseAsset = { ...asset, size: asset.size + 1 };
      await assert.rejects(client.downloadAsset(lying, join(dir, "lie.zip")), (e: unknown) => {
        return e instanceof UpdateErr && e.code === "download";
      });
    });
  });

  test("fetchAssetText reads SHA256SUMS, honours the cap, and the sums match the bundle", async () => {
    const { releases } = await client.listReleases();
    const rel = releases.find((r) => r.version === "1.2.0");
    assert.ok(rel);
    const sums = findChecksumAssets(rel, BUNDLE_120_NAME).sums;
    assert.ok(sums, "SHA256SUMS present");
    const text = await client.fetchAssetText(sums);
    assert.equal(sumFor(BUNDLE_120_NAME, text, null), sha256(BUNDLE_120));
    await assert.rejects(client.fetchAssetText(sums, 10), (e: unknown) => {
      return e instanceof UpdateErr && e.code === "download";
    });
  });

  test("checksum variants from the fake: per-asset files, and wrong sums that do not match", async () => {
    const { releases } = await client.listReleases();
    const rc = releases.find((r) => r.version === "1.3.0-rc.1");
    assert.ok(rc);
    const rcName = "omnichat-server-bundle-1.3.0-rc.1.zip";
    const rcFiles = findChecksumAssets(rc, rcName);
    assert.equal(rcFiles.sums, null, "per-asset mode has no combined SHA256SUMS");
    assert.ok(rcFiles.per, "per-asset .sha256 present");
    const rcAsset = rc.assets.find((a) => a.name === rcName);
    assert.ok(rcAsset);
    const rcText = await client.fetchAssetText(rcFiles.per);
    assert.equal(sumFor(rcName, null, rcText), sha256("rc bundle"));

    const old = releases.find((r) => r.version === "1.1.0");
    assert.ok(old);
    const oldName = "omnichat-server-bundle-1.1.0.zip";
    const oldSums = findChecksumAssets(old, oldName).sums;
    assert.ok(oldSums);
    const oldText = await client.fetchAssetText(oldSums);
    assert.notEqual(sumFor(oldName, oldText, null), sha256("old bundle"));
  });

  test("a token never appears in thrown messages", async () => {
    const secret = "ghp_super_secret_leak_check_42";
    const c = new GithubClient({ apiBase: fake.base, repo: REPO, token: secret, allowHttp: true });
    const err = await c.listReleases().then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof UpdateErr, "expected an UpdateErr (wrong token -> unauthorized)");
    assert.equal(err.message.includes(secret), false);
    assert.equal(JSON.stringify(err).includes(secret), false);

    // A transport error whose text echoes the token is redacted.
    const echo = new GithubClient({
      apiBase: fake.base,
      repo: REPO,
      token: secret,
      allowHttp: true,
      fetchImpl: (async () => {
        throw new Error(`boom ${secret}`);
      }) as unknown as typeof fetch,
    });
    const err2 = await echo.listReleases().then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err2 instanceof UpdateErr);
    assert.equal(err2.code, "network");
    assert.equal(err2.message.includes(secret), false);
    assert.ok(err2.message.includes("[redacted]"));
  });
});

// ---- release asset helpers (pure) --------------------------------------------------------------

describe("release asset helpers", () => {
  test("findServerBundle matches only the exact versioned zip", () => {
    const r = release("1.2.0", {
      assets: [assetNamed("omnichat-server-bundle-1.2.0.zip"), assetNamed("OmniChat-Server-Setup-1.2.0.exe")],
    });
    assert.equal(findServerBundle(r)?.name, "omnichat-server-bundle-1.2.0.zip");
    assert.equal(findServerBundle(release("1.2.0", { assets: [assetNamed("omnichat-server-bundle-1.1.0.zip")] })), null);
    assert.equal(findServerBundle(release("1.2.0")), null);
  });

  test("findPlugin picks the newest valid omnichat-dsh-bridge tgz", () => {
    const r = release("1.2.0", {
      assets: [
        assetNamed("omnichat-dsh-bridge-0.2.0.tgz"),
        assetNamed("omnichat-dsh-bridge-0.10.0.tgz"),
        assetNamed("omnichat-dsh-bridge-x.tgz"),
        assetNamed("omnichat-dsh-bridge-0.9.0.zip"),
      ],
    });
    const p = findPlugin(r);
    assert.ok(p);
    assert.equal(p.version, "0.10.0");
    assert.equal(p.assetName, "omnichat-dsh-bridge-0.10.0.tgz");
    assert.equal(p.downloadUrl, "https://github.com/x/y/releases/download/v1/omnichat-dsh-bridge-0.10.0.tgz");
    assert.equal(findPlugin(release("1.2.0", { assets: [assetNamed("x.zip")] })), null);
  });

  test("findChecksumAssets finds SHA256SUMS and <name>.sha256", () => {
    const both = findChecksumAssets(
      release("1.2.0", { assets: [assetNamed("b.zip"), assetNamed("SHA256SUMS"), assetNamed("b.zip.sha256")] }),
      "b.zip",
    );
    assert.equal(both.sums?.name, "SHA256SUMS");
    assert.equal(both.per?.name, "b.zip.sha256");
    const none = findChecksumAssets(release("1.2.0", { assets: [assetNamed("b.zip")] }), "b.zip");
    assert.equal(none.sums, null);
    assert.equal(none.per, null);
  });
});
