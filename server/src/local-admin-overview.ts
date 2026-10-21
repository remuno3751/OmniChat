// Read-mostly overview endpoints for the server app's dashboard (loopback + local-admin token, see local-admin.ts).
import { isAgentBridgeKind, vscodeProviderRefusal } from "./agent-kinds.js";
import type { FastifyInstance } from "fastify";
import { AuthError } from "./auth.js";
import { db, nextSeq, getProviderRow, toProvider } from "./db.js";
import { randomUUID } from "node:crypto";
import { encryptSecret } from "./secret.js";
import { forbiddenOutboundUrl } from "./url-guard.js";
import { broadcast } from "./hub.js";
import { providerKinds } from "./providers/index.js";
import { activeCount } from "./chat.js";
import { connectionCount, connectedUserIds } from "./hub.js";
import { listAllBridges } from "./bridges.js";
import { probeAll } from "./local-servers.js";
import { createBackup, deleteBackup, listBackups } from "./backup.js";
import { requireLocal } from "./local-admin.js";
import { removeProviderGrants } from "./shared-providers.js";

export function registerLocalAdminOverview(app: FastifyInstance): void {
  app.get("/local-admin/overview", async (req) => {
    requireLocal(req);
    const names = new Map((db.prepare("SELECT id, username FROM users").all() as any[]).map((u) => [u.id, u.username]));
    const adminIds = new Set((db.prepare("SELECT id FROM users WHERE is_admin = 1").all() as any[]).map((u) => u.id as string));
    const providers = (db.prepare("SELECT id, user_id, name, kind, base_url, model, shared, effort_profile AS effortProfile FROM providers WHERE deleted = 0 ORDER BY user_id, seq").all() as any[])
      .map((p) => ({
        id: p.id, owner: names.get(p.user_id) ?? "", name: p.name, kind: p.kind, baseUrl: p.base_url, model: p.model,
        // shared: the admin's flag; adminOwned: only admin-owned providers can be shared (the server app shows the switch for them)
        shared: !!p.shared, adminOwned: adminIds.has(p.user_id),
      }));
    return {
      connections: { sockets: connectionCount(), users: connectedUserIds().map((id) => names.get(id) ?? "") },
      bridges: listAllBridges().map((b) => ({ owner: names.get(b.userId) ?? "", name: b.name, cwd: b.cwd })),
      activeChats: activeCount(),
      localServers: await probeAll(),
      providers,
    };
  });
  // add / remove a model provider for a user (default owner: the oldest account, i.e. the first admin)
  const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
  app.post("/local-admin/providers", async (req) => {
    requireLocal(req);
    const b = (req.body ?? {}) as any;
    const kind = str(b.kind) ? b.kind.trim() : "openai-compatible";
    if (!providerKinds().includes(kind) && kind !== "vscode-bridge") throw new AuthError("Unknown provider kind", 400);
    if (!str(b.name) || !str(b.baseUrl)) throw new AuthError("name and baseUrl are required", 400);
    const baseUrl = b.baseUrl.trim();
    const bad = isAgentBridgeKind(kind) ? null : forbiddenOutboundUrl(baseUrl);
    if (bad) throw new AuthError("baseUrl: " + bad, 400);
    const vsBad = vscodeProviderRefusal(kind, baseUrl, b.apiKey);
    if (vsBad) throw new AuthError(vsBad, 400);
    const owner = (str(b.owner)
      ? db.prepare("SELECT id FROM users WHERE username = ?").get(b.owner.trim())
      : db.prepare("SELECT id FROM users ORDER BY created_at ASC LIMIT 1").get()) as { id: string } | undefined;
    if (!owner) throw new AuthError("Owner account not found (create an account first)", 404);
    const id = randomUUID();
    db.prepare(
      "INSERT INTO providers (id, user_id, name, kind, base_url, model, api_key, created_at, deleted, seq) VALUES (?,?,?,?,?,?,?,?,0,?)",
    ).run(id, owner.id, b.name.trim(), kind, baseUrl, typeof b.model === "string" ? b.model.trim() : "", typeof b.apiKey === "string" && b.apiKey ? encryptSecret(b.apiKey) : "", Date.now(), nextSeq());
    const p = toProvider(getProviderRow(id));
    broadcast(owner.id, { type: "upsert", providers: [p] });
    return p;
  });
  app.delete("/local-admin/providers/:id", async (req) => {
    requireLocal(req);
    const row = getProviderRow((req.params as any).id);
    if (!row || row.deleted) throw new AuthError("Provider not found", 404);
    db.prepare("UPDATE providers SET deleted = 1, seq = ? WHERE id = ?").run(nextSeq(), row.id);
    removeProviderGrants(row.id);
    broadcast(row.user_id, { type: "upsert", providers: [toProvider(getProviderRow(row.id))] });
    return { ok: true };
  });
  app.get("/local-admin/backups", async (req) => { requireLocal(req); return { backups: listBackups() }; });
  app.post("/local-admin/backups", async (req) => { requireLocal(req); return createBackup(); });
  app.delete("/local-admin/backups/:name", async (req) => {
    requireLocal(req);
    if (!deleteBackup((req.params as any).name)) throw new AuthError("Backup not found", 404);
    return { ok: true };
  });
}
