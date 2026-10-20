import { parseArgs } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Bridge } from "./bridge.js";
import { defaultAppDir } from "./dsh.js";
import { defaultDshHome } from "./models.js";

const log = (m: string) => console.error(`[bridge ${new Date().toISOString()}] ${m}`);
const fail = (m: string): never => {
  console.error(`error: ${m}`);
  process.exit(2);
};

const { values } = parseArgs({
  options: {
    server: { type: "string" },
    token: { type: "string" },
    username: { type: "string" },
    password: { type: "string" },
    name: { type: "string" },
    cwd: { type: "string" },
    "dsh-app": { type: "string" },
    "dsh-patch": { type: "string" },
    profile: { type: "string" },
    "no-mirror": { type: "boolean" },
    "mirror-all": { type: "boolean" },
    "allow-preview-fs": { type: "boolean" },
    "dsh-home": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.error(
    "usage: npm start -- --server <url> (--token <t> | --username <u> --password <p>) --cwd <dir> [--name n] [--dsh-app dir] [--dsh-patch file|none] [--profile headless] [--no-mirror] [--mirror-all] [--dsh-home dir] [--allow-preview-fs]\nenv: OMNICHAT_TOKEN, OMNICHAT_USERNAME, OMNICHAT_PASSWORD",
  );
  process.exit(0);
}

const server = values.server ?? fail("--server is required");
const token = values.token ?? process.env.OMNICHAT_TOKEN;
const username = values.username ?? process.env.OMNICHAT_USERNAME;
const password = values.password ?? process.env.OMNICHAT_PASSWORD;
if (!token && !(username && password)) fail("provide --token or --username/--password (or OMNICHAT_* env vars)");
if (!values.cwd) fail("--cwd is required");
const cwd = path.resolve(values.cwd!);
if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) fail(`--cwd does not exist: ${cwd}`);
try {
  new URL(server);
} catch {
  fail(`invalid --server URL: ${server}`);
}

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const patchArg = values["dsh-patch"] ?? path.join(pkgDir, "dsh-overlay.yml");
const patch = patchArg === "none" ? null : path.resolve(patchArg);
const appDir = values["dsh-app"] ?? defaultAppDir();

let cached: string | undefined = token;
async function getToken(): Promise<string> {
  if (cached) return cached;
  const url = new URL(server);
  url.pathname = url.pathname.replace(/\/+$/, "") + "/auth/login";
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!res.ok || !body.token) throw new Error(`login failed (HTTP ${res.status}${body.error ? `: ${body.error}` : ""})`);
  cached = body.token;
  return cached;
}

const bridge = new Bridge({
  serverUrl: server,
  getToken,
  onAuthFailure: () => {
    if (!token) cached = undefined;
  },
  name: values.name ?? os.hostname(),
  cwd,
  dsh: { appDir, profile: values.profile ?? "headless", patch },
  dshHome: values["dsh-home"] ? path.resolve(values["dsh-home"]) : defaultDshHome(),
  mirror: !values["no-mirror"],
  mirrorAll: !!values["mirror-all"],
  previewFs: !!values["allow-preview-fs"],
  log,
  warn: (m) => console.error(m),
});

log(`workspace: ${cwd}`);
if (values["allow-preview-fs"]) log("preview file access ON: files under the workspace (read-only, allow-listed types) can be read by the server");
bridge.start();

let exiting = false;
const shutdown = () => {
  if (exiting) process.exit(1);
  exiting = true;
  log("shutting down");
  bridge.stop();
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
