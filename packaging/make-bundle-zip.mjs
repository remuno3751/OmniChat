#!/usr/bin/env node
// Builds the platform-independent server update bundle (omnichat-server-bundle-<ver>.zip).
//   node packaging/make-bundle-zip.mjs <stageServerDir> <outZip>
//
// The zip has NO wrapping folder: dist/, web/, node_modules/, package.json, ..., bundle.json sit at the root.
// Left out of the stage: runtime/ (the platform Node binary) and start.cmd / start.sh (launchers, not update content).
// Refuses to build when dist/boot.js or bundle.json is missing (the updater would reject such a bundle anyway).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

// jszip is a server dependency: resolve it from server/node_modules (works in CI and on the dev machine)
const here = path.dirname(fileURLToPath(import.meta.url));
const JSZip = createRequire(path.join(here, "..", "server", "package.json"))("jszip");

const EXCLUDE_TOP = new Set(["runtime", "start.cmd", "start.sh"]);
const SKIP_PATHS = new Set(["node_modules/.bin"]); // npm bin shims: not needed to run the server
const MAX_FILES = 200000; // same entry cap the updater enforces when unpacking
const FIXED_DATE = new Date(Date.UTC(2020, 0, 1)); // fixed timestamps: same input gives the same zip

function fail(msg) {
  console.error(`make-bundle-zip: ${msg}`);
  process.exit(1);
}

const [stageArg, outArg] = process.argv.slice(2);
if (!stageArg || !outArg) fail("usage: node packaging/make-bundle-zip.mjs <stageServerDir> <outZip>");
const stage = path.resolve(stageArg);
const outZip = path.resolve(outArg);
const tmpZip = `${outZip}.part`;

if (!fs.existsSync(stage) || !fs.statSync(stage).isDirectory()) fail(`stage dir not found: ${stage}`);
for (const req of ["dist/boot.js", "bundle.json"]) {
  if (!fs.existsSync(path.join(stage, req))) fail(`refusing to build: ${req} missing in ${stage}`);
}
let meta;
try {
  meta = JSON.parse(fs.readFileSync(path.join(stage, "bundle.json"), "utf8"));
} catch (e) {
  fail(`bundle.json is not valid JSON: ${e.message}`);
}
if (typeof meta.version !== "string" || !meta.version) fail("bundle.json has no version");

// Walk the stage dir in sorted order. Symlinks are skipped (the updater rejects them).
function collect(dirAbs, relPrefix, out) {
  const names = fs.readdirSync(dirAbs).sort();
  for (const name of names) {
    const rel = relPrefix ? `${relPrefix}/${name}` : name;
    if (!relPrefix && EXCLUDE_TOP.has(name)) continue;
    if (SKIP_PATHS.has(rel)) continue;
    const abs = path.join(dirAbs, name);
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) {
      console.warn(`make-bundle-zip: skipping symlink ${rel}`);
    } else if (st.isDirectory()) {
      collect(abs, rel, out);
    } else if (st.isFile()) {
      out.push({ rel, abs, size: st.size });
    }
    if (out.length > MAX_FILES) fail(`more than ${MAX_FILES} files`);
  }
  return out;
}
const files = collect(stage, "", []);

// JSZip keeps each added file in memory until generate() runs, so peak memory is about the uncompressed size.
// The zip itself is streamed to disk (generateNodeStream -> file write stream).
const zip = new JSZip();
let totalIn = 0;
for (const f of files) {
  zip.file(f.rel, fs.readFileSync(f.abs), {
    binary: true,
    createFolders: false,
    date: FIXED_DATE,
    unixPermissions: 0o644,
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  totalIn += f.size;
}

fs.mkdirSync(path.dirname(outZip), { recursive: true });
try {
  await pipeline(
    zip.generateNodeStream({
      type: "nodebuffer",
      streamFiles: true,
      platform: "UNIX",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    }),
    fs.createWriteStream(tmpZip),
  );
  fs.renameSync(tmpZip, outZip);
} catch (e) {
  fs.rmSync(tmpZip, { force: true });
  fail(`zip failed: ${e.message}`);
}

// sha256 of the finished file (streamed)
const hash = crypto.createHash("sha256");
for await (const chunk of fs.createReadStream(outZip)) hash.update(chunk);
const size = fs.statSync(outZip).size;

console.log(`bundle version: ${meta.version}`);
console.log(`files: ${files.length}  uncompressed: ${(totalIn / 1048576).toFixed(1)} MiB`);
console.log(`wrote: ${outZip}`);
console.log(`size: ${size} bytes (${(size / 1048576).toFixed(2)} MiB)`);
console.log(`sha256: ${hash.digest("hex")}`);
