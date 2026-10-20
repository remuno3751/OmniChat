#!/usr/bin/env node
// Builds the server (web UI + dist + production node_modules + Node runtime) into src-tauri/bundle/server, which
// tauri.conf.json ships as app resources. Usage: node tools/prepare-bundle.mjs [--node <path-to-node-binary>]
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const out = resolve(here, "..", "src-tauri", "bundle");
const i = process.argv.indexOf("--node");
const nodeBin = i > 0 ? process.argv[i + 1] : process.execPath; // the Node running this script becomes the bundled runtime
const version = (process.env.OMNICHAT_VERSION || JSON.parse(readFileSync(join(root, "server", "package.json"), "utf8")).version).replace(/^v/, "");

rmSync(out, { recursive: true, force: true });
execFileSync(process.execPath, [join(root, "packaging", "build-release.mjs"), "--out", out, "--version", version, "--node", nodeBin], { stdio: "inherit" });
