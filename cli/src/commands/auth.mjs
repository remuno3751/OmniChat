import os from "node:os";
import { api, normalizeServer, requireAuth } from "../client.mjs";
import { saveConfig } from "../config.mjs";
import { readSecretLine } from "../prompt.mjs";
import { CliError, UsageError } from "../util.mjs";
import { defaultAsk } from "../prompt.mjs";

export const loginOpts = {
  username: { type: "string" },
  register: { type: "bool" },
};

export async function loginCommand(ctx) {
  const f = ctx.flags;
  if (!ctx.server) {
    throw new UsageError("--server URL is required (or set OMNICHAT_SERVER)");
  }
  let username = f.username ?? ctx.env.OMNICHAT_USERNAME ?? ctx.config.username;
  if (!username) {
    if (!ctx.io.stdinIsTTY) throw new UsageError("--username is required when not on a terminal (or set OMNICHAT_USERNAME)");
    username = (await (ctx.io.ask ?? ((q) => defaultAsk(q, ctx.io)))("Username: ")).trim();
  }
  if (!username) throw new UsageError("username must not be empty");
  let password = ctx.env.OMNICHAT_PASSWORD;
  if (password == null || password === "") password = await readSecretLine(ctx, "Password: ");
  if (!password) throw new CliError("empty password");
  ctx.secrets.add(password);
  const path = f.register ? "/auth/register" : "/auth/login";
  let r;
  try {
    r = await api(ctx, "POST", path, {
      auth: false,
      body: { username, password, deviceName: `CLI (${os.hostname()})`, platform: "cli" },
    });
  } catch (e) {
    if (f.register && /403/.test(e.message)) {
      throw new CliError("registration is disabled on this server (ask the admin, or set ALLOW_REGISTRATION=1 on the server)");
    }
    throw e;
  }
  if (!r?.token) throw new CliError("server did not return a token");
  ctx.secrets.add(r.token);
  const cfg = { server: ctx.server, token: r.token, deviceId: r.deviceId ?? null, username: r.username ?? username };
  saveConfig(ctx.configPath, cfg);
  ctx.out(`Logged in to ${ctx.server} as ${cfg.username} (device "CLI (${os.hostname()})").\n`);
  return 0;
}

export async function logoutCommand(ctx) {
  if (!ctx.config.token) {
    ctx.err("not logged in");
    return 0;
  }
  let note = "";
  try {
    await api(ctx, "POST", "/auth/logout", { body: {} });
  } catch (e) {
    note = ` (server revoke failed: ${e.message})`;
  }
  const { token, deviceId, username, ...rest } = ctx.config;
  void token; void deviceId; void username;
  saveConfig(ctx.configPath, rest);
  ctx.out(`Logged out${note}.\n`);
  return 0;
}

export const whoamiOpts = { json: { type: "bool" } };

export async function whoamiCommand(ctx) {
  requireAuth(ctx);
  const r = await api(ctx, "GET", "/devices");
  const dev = (r?.devices ?? []).find((d) => d.current);
  const info = { server: ctx.server, username: ctx.config.username ?? null, device: dev ? { id: dev.id, name: dev.name } : null };
  if (ctx.flags.json) {
    ctx.out(JSON.stringify(info, null, 2) + "\n");
    return 0;
  }
  ctx.out(`${info.username ?? "(unknown user)"} @ ${info.server}\n`);
  if (dev) ctx.out(`device: ${dev.name} (${dev.id})\n`);
  return 0;
}
