// Builds the combined `SHA256SUMS` of a release from the per-platform lists that each build step uploaded
// (SHA256SUMS-bundle.txt, -tools.txt, -desktop.txt, -server-app.txt, -android.txt, -desktop-mac.txt, ...).
// The in-app updaters (server, desktop launcher, DSH plugin) look for a release asset named exactly `SHA256SUMS`
// (or `<asset>.sha256`); without it they refuse to update ("no checksum"). Run this once after ALL builds are uploaded:
//   OMNICHAT_REPO=owner/name node packaging/local/finalize-release.mjs v0.5.0
import { execSync } from "node:child_process";

const tag = process.argv[2];
if (!tag) { console.error("usage: node packaging/local/finalize-release.mjs <tag>"); process.exit(1); }
const REPO = process.env.OMNICHAT_REPO || "remuno3751/omnichat";
const cred = execSync("git credential fill", { input: "protocol=https\nhost=github.com\n\n" }).toString();
const TOKEN = /^password=(.*)$/m.exec(cred)?.[1]?.trim();
if (!TOKEN) { console.error("no GitHub credential found in git credential helper"); process.exit(1); }
const H = { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "omnichat-release" };
const api = async (path, opt = {}) => {
  const r = await fetch(`https://api.github.com/repos/${REPO}${path}`, { ...opt, headers: { ...H, ...(opt.headers || {}) } });
  if (!r.ok && r.status !== 204) throw new Error(`${opt.method || "GET"} ${path} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
};

const rels = await api("/releases?per_page=50");
const rel = rels.find((r) => r.tag_name === tag);
if (!rel) throw new Error(`no release for ${tag}`);

const lines = new Map(); // asset name -> "<hex> *<name>"
for (const a of rel.assets.filter((x) => /^SHA256SUMS-.+\.txt$/.test(x.name))) {
  const res = await fetch(a.url, { headers: { ...H, Accept: "application/octet-stream" }, redirect: "follow" });
  if (!res.ok) throw new Error(`${a.name}: ${res.status}`);
  for (const raw of (await res.text()).split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})[ \t]+\*?(.+?)\s*$/.exec(raw.trim());
    if (m) lines.set(m[2], `${m[1].toLowerCase()} *${m[2]}`);
  }
}
const missing = rel.assets.map((a) => a.name).filter((n) => !/^SHA256SUMS/.test(n) && !lines.has(n));
const body = [...lines.values()].sort().join("\n") + "\n";

const old = rel.assets.find((a) => a.name === "SHA256SUMS");
if (old) await api(`/releases/assets/${old.id}`, { method: "DELETE" });
const up = await fetch(`https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=SHA256SUMS`, {
  method: "POST", headers: { ...H, "Content-Type": "text/plain" }, body,
});
if (!up.ok) throw new Error(`upload SHA256SUMS -> ${up.status} ${(await up.text()).slice(0, 200)}`);
console.log(`SHA256SUMS: ${lines.size} entries`);
if (missing.length) console.log("assets without a checksum line:", missing.join(", "));
