import fs from "node:fs";
import { api } from "../client.mjs";
import { CliError, UsageError, fmtDate, oneOf, truncate } from "../util.mjs";
import { fetchSync, requireProject, resolveConversation, branchPath } from "./sync.mjs";

export const historyOpts = {
  limit: { type: "int" },
  project: { type: "string", alias: "p" },
  json: { type: "bool" },
};

export async function historyCommand(ctx) {
  const f = ctx.flags;
  const sync = await fetchSync(ctx);
  let convs = sync.conversations;
  if (f.project) {
    const p = requireProject(sync, f.project);
    convs = convs.filter((c) => c.projectId === p.id);
  }
  convs = convs.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, f.limit ?? 20);
  if (f.json) {
    ctx.out(JSON.stringify({ conversations: convs }, null, 2) + "\n");
    return 0;
  }
  if (convs.length === 0) {
    ctx.err("no conversations");
    return 0;
  }
  const projName = new Map(sync.projects.map((p) => [p.id, p.name]));
  for (const c of convs) {
    const proj = c.projectId && projName.get(c.projectId) ? ` [${projName.get(c.projectId)}]` : "";
    ctx.out(`${c.id}  ${fmtDate(c.updatedAt)}${proj}  ${truncate(c.title, 60)}\n`);
  }
  return 0;
}

export const showOpts = { json: { type: "bool" }, thinking: { type: "bool" } };

export async function showCommand(ctx, pos) {
  if (pos.length !== 1) throw new UsageError("usage: omnichat show <conversationId>");
  const sync = await fetchSync(ctx);
  const conv = resolveConversation(sync, pos[0]);
  const path = branchPath(sync, conv);
  if (ctx.flags.json) {
    ctx.out(JSON.stringify({ conversation: conv, messages: path }, null, 2) + "\n");
    return 0;
  }
  const prov = sync.providers.find((p) => p.id === conv.providerId);
  const proj = sync.projects.find((p) => p.id === conv.projectId);
  const meta = [
    conv.model ? `model: ${prov ? prov.name + "/" : ""}${conv.model}` : "",
    proj ? `project: ${proj.name}` : "",
    `updated: ${fmtDate(conv.updatedAt)}`,
  ].filter(Boolean).join("  ");
  ctx.out(`${ctx.style.bold(conv.title)}\n${ctx.style.dim(meta)}\n`);
  for (const m of path) {
    const who = m.role === "user" ? ctx.style.cyan("You") : ctx.style.green("Assistant");
    ctx.out(`\n${who}:\n`);
    if (ctx.flags.thinking && m.reasoning) {
      ctx.out(m.reasoning.split("\n").map((l) => ctx.style.dim("> " + l)).join("\n") + "\n");
    }
    ctx.out(`${m.content}\n`);
    if (Array.isArray(m.sources) && m.sources.length) {
      ctx.out("\n" + m.sources.map((s) => `[${s.index}] ${s.title} — ${s.url}`).join("\n") + "\n");
    }
  }
  return 0;
}

export const searchOpts = {
  limit: { type: "int" },
  offset: { type: "int" },
  project: { type: "string", alias: "p" },
  json: { type: "bool" },
};

export async function searchCommand(ctx, pos) {
  const q = pos.join(" ").trim();
  if (!q) throw new UsageError('usage: omnichat search "<query>"');
  const f = ctx.flags;
  const params = new URLSearchParams({ q, limit: String(f.limit ?? 20) });
  if (f.offset) params.set("offset", String(f.offset));
  if (f.project) {
    const sync = await fetchSync(ctx);
    params.set("projectId", requireProject(sync, f.project).id);
  }
  const r = await api(ctx, "GET", `/history/search?${params}`);
  if (f.json) {
    ctx.out(JSON.stringify(r, null, 2) + "\n");
    return 0;
  }
  const results = r?.results ?? [];
  if (results.length === 0) {
    ctx.err("no matches");
    return 0;
  }
  const hl = (s) => String(s ?? "")
    .replace(/\u0001/g, ctx.style.enabled ? "\u001b[1m" : "«")
    .replace(/\u0002/g, ctx.style.enabled ? "\u001b[22m" : "»")
    .replace(/\s+/g, " ");
  for (const h of results) {
    const who = h.messageId ? h.role ?? "" : "title";
    ctx.out(`${ctx.style.bold(truncate(h.conversationTitle, 50))}  ${ctx.style.dim(`${h.conversationId}  ${who}  ${fmtDate(h.createdAt)}`)}\n  ${hl(h.snippet)}\n`);
  }
  if (typeof r.total === "number" && r.total > results.length) ctx.err(`(${results.length} of ${r.total} shown; use --limit/--offset)`);
  return 0;
}

export const exportOpts = {
  format: { type: "enum", values: ["md", "json"] },
  output: { type: "string", alias: "o" },
  reasoning: { type: "bool" },
  "all-branches": { type: "bool" },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function exportCommand(ctx, pos) {
  if (pos.length !== 1) throw new UsageError("usage: omnichat export <conversationId> [--format md|json] [-o file]");
  const f = ctx.flags;
  let format = oneOf(f.format, ["md", "json"], "format");
  if (!format && f.output) format = /\.json$/i.test(f.output) ? "json" : "md";
  format ??= "md";
  // Short id prefixes are resolved via /sync; full UUIDs go straight to the export endpoint.
  let id = pos[0];
  if (!UUID.test(id)) id = resolveConversation(await fetchSync(ctx), id).id;
  const params = new URLSearchParams({ format, branches: f.allBranches ? "all" : "current" });
  if (f.reasoning) params.set("reasoning", "1");
  const text = await api(ctx, "GET", `/conversations/${encodeURIComponent(id)}/export?${params}`, { text: true });
  if (f.output && f.output !== "-") {
    try {
      fs.writeFileSync(f.output, text);
    } catch (e) {
      throw new CliError(`cannot write ${f.output}: ${e.message}`);
    }
    ctx.err(`wrote ${f.output} (${text.length} chars)`);
  } else {
    ctx.out(text.endsWith("\n") ? text : text + "\n");
  }
  return 0;
}
