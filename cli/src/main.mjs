// Entry point: parse argv, build the command context, dispatch, map errors to exit codes.
import { OPTS, parseArgs } from "./args.mjs";
import { loadConfig, configPath as defaultConfigPath } from "./config.mjs";
import { normalizeServer } from "./client.mjs";
import { makeStyle } from "./ui.mjs";
import { CliError, UsageError, makeRedactor } from "./util.mjs";
import { loginCommand, logoutCommand, whoamiCommand } from "./commands/auth.mjs";
import { modelsCommand } from "./commands/models.mjs";
import { chatCommand } from "./commands/chat.mjs";
import { historyCommand, showCommand, searchCommand, exportCommand } from "./commands/history.mjs";
import { benchCommand } from "./commands/bench.mjs";
import { configCommand } from "./commands/config.mjs";
import { doctorCommand } from "./commands/doctor.mjs";
import { defaultAsk } from "./prompt.mjs";
import { HELP, commandHelp, VERSION } from "./help.mjs";

/** The real process streams (used by bin/omnichat.mjs). */
export function realIo() {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    stdinIsTTY: !!process.stdin.isTTY,
    stdoutIsTTY: !!process.stdout.isTTY,
    stderrIsTTY: !!process.stderr.isTTY,
    fetch: globalThis.fetch,
    WebSocket: globalThis.WebSocket,
    onSigint(fn) {
      process.on("SIGINT", fn);
      return () => process.off("SIGINT", fn);
    },
  };
}

const COMMANDS = {
  login: loginCommand,
  logout: logoutCommand,
  whoami: whoamiCommand,
  models: modelsCommand,
  chat: chatCommand,
  history: historyCommand,
  show: showCommand,
  search: searchCommand,
  export: exportCommand,
  bench: benchCommand,
  config: configCommand,
  doctor: doctorCommand,
};

/**
 * Run the CLI. Returns the exit code (0 ok, 1 error, 2 usage, 130 interrupted).
 * `io` and `env` are injectable for tests; defaults are the real process.
 */
export async function main(argv, { env = process.env, io = realIo() } = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv, OPTS);
  } catch (e) {
    return fail(io, e, false);
  }
  const { flags, positionals } = parsed;
  const [command, ...pos] = positionals;

  if (flags.version) {
    io.stdout.write(VERSION + "\n");
    return 0;
  }
  if (!command || command === "help") {
    io.stdout.write(HELP);
    return command ? 0 : (flags.help ? 0 : 2);
  }
  if (flags.help) {
    io.stdout.write(commandHelp(command) ?? HELP);
    return 0;
  }
  if (!COMMANDS[command]) {
    return fail(io, new UsageError(`unknown command: ${command} (see \`omnichat help\`)`), flags.debug);
  }

  const secrets = new Set();
  const redact = makeRedactor(secrets);
  const noColor = !!flags.noColor || !!env.NO_COLOR;
  const ctx = {
    command,
    flags,
    env,
    io,
    secrets,
    redact,
    style: makeStyle(!noColor && !!io.stdoutIsTTY && !!io.stderrIsTTY),
    timeoutMs: (flags.timeout ?? 30) * 1000,
    configPath: env.OMNICHAT_CONFIG || defaultConfigPath(env),
    out: (s) => io.stdout.write(s),
    err: (s) => io.stderr.write(redact(s) + "\n"),
    errRaw: (s) => io.stderr.write(redact(s)),
    info: (s) => { if (!flags.quiet) io.stderr.write(redact(s) + "\n"); },
    debug: (s) => { if (flags.debug) io.stderr.write(`[debug] ${redact(s)}\n`); },
    ask: io.ask ?? ((q) => defaultAsk(q, io)),
  };

  try {
    ctx.config = loadConfig(ctx.configPath);
    resolveConnection(ctx);
    return await COMMANDS[command](ctx, pos);
  } catch (e) {
    return fail(io, e, flags.debug, redact);
  }
}

/** Work out server + token: flags/env override the saved config. A saved token is never sent to another server. */
function resolveConnection(ctx) {
  const cfg = ctx.config;
  const envServer = ctx.env.OMNICHAT_SERVER;
  ctx.server = normalizeServer(ctx.flags.server ?? envServer ?? cfg.server ?? "");
  const savedServer = normalizeServer(cfg.server ?? "");
  const overridden = !!ctx.server && ctx.server !== savedServer;
  ctx.token = ctx.env.OMNICHAT_TOKEN || (overridden ? undefined : cfg.token) || undefined;
  ctx.tokenServerMismatch = overridden && !ctx.env.OMNICHAT_TOKEN && !!cfg.token;
  if (ctx.token) ctx.secrets.add(ctx.token);
  if (cfg.token) ctx.secrets.add(cfg.token);
}

function fail(io, e, debug, redact = (s) => s) {
  if (e instanceof CliError) {
    const hint = e.usage ? `\n(run \`omnichat help\` for usage)` : "";
    io.stderr.write(`error: ${redact(e.message)}${hint}\n`);
    if (debug && e.stack) io.stderr.write(redact(e.stack) + "\n");
    return e.exitCode ?? 1;
  }
  io.stderr.write(`error: ${redact(e?.message ?? String(e))}\n`);
  if (debug && e?.stack) io.stderr.write(redact(e.stack) + "\n");
  return 1;
}
