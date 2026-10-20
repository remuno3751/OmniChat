import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "./util.mjs";

export function configPath(env = process.env, platform = process.platform) {
  if (env.OMNICHAT_CONFIG) return env.OMNICHAT_CONFIG;
  if (platform === "win32") {
    const base = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "omnichat", "config.json");
  }
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config");
  return path.join(base, "omnichat", "config.json");
}

export function loadConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw new CliError(`cannot read config file ${file}: ${e.message}`);
  }
  try {
    const cfg = JSON.parse(text);
    return cfg && typeof cfg === "object" ? cfg : {};
  } catch {
    throw new CliError(`config file ${file} is not valid JSON (delete it or run \`omnichat login\` again)`);
  }
}

/** Atomically write the config with mode 0600 (best effort; a no-op on Windows). */
export function saveConfig(file, cfg) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* unsupported */ }
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* unsupported */ }
}
