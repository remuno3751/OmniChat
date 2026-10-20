#!/usr/bin/env node
// OmniChat release builder (cross-platform).
//
// Produces  <out>/server/  : a self-contained server folder
//   dist/ node_modules/ web/ package.json package-lock.json config.env.example VERSION bundle.json LICENSE NOTICE THIRD_PARTY_NOTICES.txt
//   runtime/node[.exe]   (only with --node)
//
// Usage:
//   node packaging/build-release.mjs [--out .release/stage] [--version 1.2.3]
//        [--node <path to node(.exe)>] [--web <prebuilt web dir>] [--dist <prebuilt dist dir>]
//        [--skip-web] [--platform linux|win32]  (platform only affects launcher scripts; default: all)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

const out = path.resolve(opt("out", path.join(root, ".release", "stage")));
const serverSrc = path.join(root, "server");
const appSrc = path.join(root, "app");
const pkg = JSON.parse(fs.readFileSync(path.join(serverSrc, "package.json"), "utf8"));
const version = (opt("version", process.env.OMNICHAT_VERSION || pkg.version) || pkg.version).replace(/^v/, "");
const nodeBin = opt("node");
const isWin = process.platform === "win32";

function run(cmd, cmdArgs, cwd) {
  console.log(`\n> ${cmd} ${cmdArgs.join(" ")}   (in ${cwd})`);
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit", shell: isWin, env: process.env });
  if (r.status !== 0) {
    console.error(`FAILED: ${cmd} ${cmdArgs.join(" ")} (exit ${r.status})`);
    process.exit(r.status || 1);
  }
}
const npm = "npm";
const npx = "npx";
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });

console.log(`OmniChat release build  version=${version}  out=${out}`);
rm(out);
const dest = path.join(out, "server");
fs.mkdirSync(dest, { recursive: true });

// 1. web client
const webDest = path.join(dest, "web");
const webPre = opt("web");
if (webPre) {
  fs.cpSync(path.resolve(webPre), webDest, { recursive: true });
} else if (!flag("skip-web")) {
  if (!fs.existsSync(path.join(appSrc, "node_modules"))) run(npm, ["ci"], appSrc);
  const tmpWeb = path.join(out, "_web");
  run(npx, ["expo", "export", "--platform", "web", "--output-dir", tmpWeb], appSrc);
  fs.renameSync(tmpWeb, webDest);
}
if (fs.existsSync(webDest) && !fs.existsSync(path.join(webDest, "index.html"))) {
  console.error("web export has no index.html"); process.exit(1);
}

// 2. server compile + production deps in a staging copy
const distPre = opt("dist");
if (distPre) {
  fs.cpSync(path.resolve(distPre), path.join(dest, "dist"), { recursive: true });
} else {
  if (!fs.existsSync(path.join(serverSrc, "node_modules"))) run(npm, ["ci"], serverSrc);
  rm(path.join(serverSrc, "dist"));
  run(npx, ["tsc", "-p", "tsconfig.build.json"], serverSrc);
  fs.cpSync(path.join(serverSrc, "dist"), path.join(dest, "dist"), { recursive: true });
  rm(path.join(serverSrc, "dist"));
}
const sp = { ...pkg, version };
delete sp.devDependencies;
// boot.js decides which bundle runs (installed one, or a newer bundle staged by the in-app updater)
sp.scripts = { start: "node dist/boot.js" };
fs.writeFileSync(path.join(dest, "package.json"), JSON.stringify(sp, null, 2) + "\n");
fs.copyFileSync(path.join(serverSrc, "package-lock.json"), path.join(dest, "package-lock.json"));
// the lockfile still lists dev deps; `npm ci --omit=dev` ignores them but requires package.json to match,
// so install with the ORIGINAL package.json then overwrite with the trimmed one.
fs.writeFileSync(path.join(dest, "package.json"), JSON.stringify({ ...pkg, version }, null, 2) + "\n");
run(npm, ["ci", "--omit=dev", "--no-audit", "--no-fund"], dest);
fs.writeFileSync(path.join(dest, "package.json"), JSON.stringify(sp, null, 2) + "\n");
rm(path.join(dest, "node_modules", ".package-lock.json"));

// 3. config + metadata + launchers
fs.copyFileSync(path.join(root, "packaging", "config.env.example"), path.join(dest, "config.env.example"));
for (const f of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.txt"]) {
  // AGPL-3.0: the license text and notices travel with every distributed copy
  if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(dest, f));
}
fs.writeFileSync(path.join(dest, "VERSION"), version + "\n");
// bundle.json: read by the in-app updater (server/src/updater/bundle.ts) to refuse bundles this host cannot run
fs.writeFileSync(
  path.join(dest, "bundle.json"),
  JSON.stringify({ version, minNode: "24.0.0", minHostEpoch: 1 }) + "\n",
);
const isPE = (f) => { const b = Buffer.alloc(2); const fd = fs.openSync(f, "r"); fs.readSync(fd, b, 0, 2, 0); fs.closeSync(fd); return b.toString() === "MZ"; };
const exe = nodeBin && isPE(path.resolve(nodeBin)) ? "node.exe" : "node";
const rt = nodeBin ? "runtime/" + exe : null;
if (nodeBin) {
  fs.mkdirSync(path.join(dest, "runtime"), { recursive: true });
  fs.copyFileSync(path.resolve(nodeBin), path.join(dest, "runtime", exe));
  if (exe === "node") fs.chmodSync(path.join(dest, "runtime", exe), 0o755);
}
// Manual launchers (no supervisor): OMNICHAT_INSTALL_TYPE=tarball, OMNICHAT_SUPERVISED is NOT set,
// so a self-update restart respawns the process instead of exiting with code 75.
fs.writeFileSync(
  path.join(dest, "start.cmd"),
  `@echo off\r\ncd /d "%~dp0"\r\nset "OMNICHAT_INSTALL_TYPE=tarball"\r\nif exist runtime\\node.exe (runtime\\node.exe dist\\boot.js) else (node dist\\boot.js)\r\n`,
);
fs.writeFileSync(
  path.join(dest, "start.sh"),
  `#!/bin/sh\ncd "$(dirname "$0")" || exit 1\nOMNICHAT_INSTALL_TYPE=tarball\nexport OMNICHAT_INSTALL_TYPE\nif [ -x runtime/node ]; then exec runtime/node dist/boot.js; else exec node dist/boot.js; fi\n`,
  { mode: 0o755 },
);
console.log(`\nDONE: ${dest}${rt ? "  (bundled runtime: " + rt + ")" : "  (no bundled runtime; needs Node >= 24)"}`);
