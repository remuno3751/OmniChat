import { api } from "../client.mjs";
import { CliError } from "../util.mjs";

export async function fetchSync(ctx) {
  const r = await api(ctx, "GET", "/sync?since=0");
  return {
    conversations: (r?.conversations ?? []).filter((c) => !c.deleted),
    messages: (r?.messages ?? []).filter((m) => !m.deleted),
    providers: (r?.providers ?? []).filter((p) => !p.deleted),
    projects: (r?.projects ?? []).filter((p) => !p.deleted),
  };
}

export function findProject(sync, name) {
  const lc = String(name).toLowerCase();
  const exact = sync.projects.filter((p) => p.name === name);
  if (exact.length === 1) return exact[0];
  const ci = sync.projects.filter((p) => p.name.toLowerCase() === lc);
  if (ci.length === 1) return ci[0];
  if (ci.length > 1) throw new CliError(`project name "${name}" is ambiguous (${ci.length} matches)`);
  return null;
}

export function requireProject(sync, name) {
  const p = findProject(sync, name);
  if (!p) {
    const names = sync.projects.map((x) => `  ${x.name}`).join("\n") || "  (none)";
    throw new CliError(`project "${name}" not found (use --create-project with chat to create it). Existing projects:\n${names}`);
  }
  return p;
}

/** Exact id or unique id prefix among live conversations. */
export function resolveConversation(sync, idOrPrefix) {
  const exact = sync.conversations.find((c) => c.id === idOrPrefix);
  if (exact) return exact;
  const hits = sync.conversations.filter((c) => c.id.startsWith(idOrPrefix));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new CliError(`conversation id prefix "${idOrPrefix}" is ambiguous (${hits.length} matches)`);
  throw new CliError(`conversation "${idOrPrefix}" not found (see \`omnichat history\`)`);
}

/** Messages along the current branch (root -> headId). */
export function branchPath(sync, conv) {
  const msgs = sync.messages.filter((m) => m.conversationId === conv.id);
  const byId = new Map(msgs.map((m) => [m.id, m]));
  if (conv.headId && byId.has(conv.headId)) {
    const path = [];
    const seen = new Set();
    let cur = byId.get(conv.headId);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      path.push(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : null;
    }
    return path.reverse();
  }
  return msgs.sort((a, b) => a.createdAt - b.createdAt);
}
