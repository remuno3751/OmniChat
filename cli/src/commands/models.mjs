import { api } from "../client.mjs";
import { CliError } from "../util.mjs";
import { table } from "../ui.mjs";

export const modelsOpts = {
  provider: { type: "string" },
  json: { type: "bool" },
  all: { type: "bool" },
};

const slug = (s) => String(s).toLowerCase().replace(/\s+/g, "-");

export async function fetchGroups(ctx, { all = false } = {}) {
  const r = await api(ctx, "GET", "/models" + (all ? "?all=1" : ""));
  return Array.isArray(r?.groups) ? r.groups : [];
}

function flatten(groups) {
  const out = [];
  for (const g of groups) {
    for (const m of g.models ?? []) {
      out.push({ providerId: g.providerId, providerName: g.providerName, model: m.id, name: m.name, state: m.state });
    }
  }
  return out;
}

const label = (c) => `${c.providerName}/${c.model}`;

/**
 * Resolve "<providerName>/<modelId>" (model ids may contain slashes) to {providerId, providerName, model}.
 * Also accepts a bare model id, a provider slug, and a unique substring. Ambiguity => error listing candidates.
 */
export function resolveModel(spec, groups) {
  const all = flatten(groups);
  if (all.length === 0) {
    throw new CliError("no models available: add a provider in OmniChat and make sure its backend is running (`omnichat models`)");
  }
  const s = String(spec).trim();
  const lc = s.toLowerCase();
  const tiers = [
    (c) => label(c) === s,
    (c) => label(c).toLowerCase() === lc || `${slug(c.providerName)}/${c.model}`.toLowerCase() === lc,
    (c) => c.model === s || c.model.toLowerCase() === lc,
    (c) => label(c).toLowerCase().includes(lc),
  ];
  for (const t of tiers) {
    const hits = all.filter(t);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      const lines = hits.slice(0, 10).map((c) => `  ${label(c)}`).join("\n");
      throw new CliError(`model "${s}" is ambiguous; candidates:\n${lines}\nUse the full <providerName>/<modelId>.`);
    }
  }
  const sample = all.slice(0, 8).map((c) => `  ${label(c)}`).join("\n");
  throw new CliError(`model "${s}" not found. Available models (see \`omnichat models\`):\n${sample}`);
}

export async function modelsCommand(ctx) {
  const f = ctx.flags;
  let groups = await fetchGroups(ctx, { all: f.all });
  if (f.provider) {
    const p = f.provider.toLowerCase();
    groups = groups.filter((g) => g.providerName?.toLowerCase() === p || slug(g.providerName ?? "") === p || g.providerId === f.provider);
    if (groups.length === 0) throw new CliError(`no provider named "${f.provider}"`);
  }
  if (f.json) {
    ctx.out(JSON.stringify({ groups }, null, 2) + "\n");
    return 0;
  }
  const rows = [];
  for (const g of groups) {
    if (g.error) ctx.err(`${ctx.style.yellow("warning")}: provider ${g.providerName}: ${g.error}`);
    for (const m of g.models ?? []) {
      const st = m.state ?? {};
      const extra = [st.loaded ? "loaded" : "", st.quantization ?? "", st.contextLength ? `ctx ${st.contextLength}` : ""].filter(Boolean).join(" ");
      rows.push([`${g.providerName}/${m.id}`, extra]);
    }
  }
  if (rows.length === 0) {
    ctx.err("no models found");
    return 0;
  }
  ctx.out(table(["MODEL", "INFO"], rows) + "\n");
  return 0;
}
