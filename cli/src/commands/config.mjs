import fs from "node:fs";
import path from "node:path";
import { api } from "../client.mjs";
import { CliError, UsageError, oneOf, readAll } from "../util.mjs";

const MAX_IMPORT = 1024 * 1024;

export async function configCommand(ctx, pos) {
  const [sub, file] = pos;
  if (pos.length > 2 || (sub !== "export" && sub !== "import")) {
    throw new UsageError("usage: omnichat config export [FILE] [--format json|yaml]\n       omnichat config import [FILE|-] [--mode merge|replace]");
  }
  if (sub === "export") return exportConfig(ctx, file);
  return importConfig(ctx, file);
}

async function exportConfig(ctx, file) {
  const format = oneOf(ctx.flags.format ?? (file && /\.ya?ml$/i.test(file) ? "yaml" : "json"), ["json", "yaml"], "format");
  const text = await api(ctx, "GET", `/config/export?format=${format}`, { text: true });
  if (file && file !== "-") {
    writeFile(file, text.endsWith("\n") ? text : text + "\n");
    ctx.info(`wrote ${file}`);
  } else {
    ctx.out(text.endsWith("\n") ? text : text + "\n");
  }
  return 0;
}

async function importConfig(ctx, file) {
  const mode = oneOf(ctx.flags.mode ?? "merge", ["merge", "replace"], "mode");
  let content;
  let source;
  if (file && file !== "-") {
    source = file;
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_IMPORT) throw new CliError(`${file} is larger than 1 MB`);
      content = fs.readFileSync(file, "utf8");
    } catch (e) {
      if (e instanceof CliError) throw e;
      throw new CliError(`cannot read ${file}: ${e.message}`);
    }
  } else {
    if (ctx.io.stdinIsTTY) throw new UsageError("usage: omnichat config import <FILE|-> (or pipe the file on stdin)");
    source = "stdin";
    content = await readAll(ctx.io.stdin);
  }
  if (Buffer.byteLength(content, "utf8") > MAX_IMPORT) throw new CliError("configuration is larger than 1 MB");
  const format = /\.ya?ml$/i.test(source) ? "yaml" : "json";
  const r = await api(ctx, "POST", "/config/import", { body: { format, content, mode } });
  const count = (o) => Object.entries(o ?? {}).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
  ctx.out(`imported ${source} (${mode}): created ${count(r?.created)}; updated ${count(r?.updated)}\n`);
  for (const s of r?.skipped ?? []) ctx.err(`skipped: ${typeof s === "string" ? s : JSON.stringify(s)}`);
  return 0;
}

function writeFile(file, text) {
  try {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, text, { mode: 0o600 });
  } catch (e) {
    throw new CliError(`cannot write ${file}: ${e.message}`);
  }
}
