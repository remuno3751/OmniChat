// Uploads local build artifacts to the GitHub release of a tag (draft or published); an asset with the same name is replaced.
// The release is created as a draft if it does not exist yet. The token comes from git's credential helper and is never printed.
//   node packaging/local/upload.mjs v0.1.0-beta.9 out/OmniChat-Desktop-macOS-universal.dmg [more files...]
import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

const [tag, ...files] = process.argv.slice(2);
if (!tag || !files.length) { console.error("usage: node packaging/local/upload.mjs <tag> <file>..."); process.exit(1); }
const REPO = process.env.OMNICHAT_REPO || "remuno3751/omnichat";
const cred = execSync("git credential fill", { input: "protocol=https\nhost=github.com\n\n" }).toString();
const TOKEN = /^password=(.*)$/m.exec(cred)?.[1]?.trim();
if (!TOKEN) { console.error("no GitHub credential found in git credential helper"); process.exit(1); }
const H = { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
const api = async (path, opt = {}) => {
  const r = await fetch(`https://api.github.com/repos/${REPO}${path}`, { ...opt, headers: { ...H, ...(opt.headers || {}) } });
  if (!r.ok && r.status !== 204) throw new Error(`${opt.method || "GET"} ${path} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
};

const rels = await api("/releases?per_page=50");
let rel = rels.find((r) => r.tag_name === tag);
if (!rel) {
  rel = await api("/releases", { method: "POST", body: JSON.stringify({ tag_name: tag, name: `OmniChat ${tag}`, draft: true, prerelease: tag.includes("-") }) });
  console.log("created draft release", tag);
}
for (const f of files) {
  const name = basename(f);
  const old = rel.assets.find((a) => a.name === name);
  if (old) await api(`/releases/assets/${old.id}`, { method: "DELETE" });
  const buf = readFileSync(f);
  const up = await fetch(`https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`, {
    method: "POST", headers: { ...H, "Content-Type": "application/octet-stream", "Content-Length": String(statSync(f).size) }, body: buf,
  });
  if (!up.ok) throw new Error(`upload ${name} -> ${up.status} ${(await up.text()).slice(0, 200)}`);
  console.log(old ? "replaced:" : "uploaded:", name, buf.length);
}
console.log("release:", rel.html_url, rel.draft ? "(draft)" : "");
