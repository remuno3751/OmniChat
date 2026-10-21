/* Shared providers and per-user model grants (docs/design/SHARED-PROVIDERS.md, docs/PROTOCOL-v7-shared-providers.md).
   Imports only db.js and server-general.js (not auth.js, to avoid a cycle). Functions here never return a provider's
   base_url or api_key; the default model is returned only by listSharedProvidersFor() and only when it is allowed. Callers
   that show providers to ordinary users must use listSharedProvidersFor(). */
import { db, getProviderRow } from "./db.js";
import { readGeneral, type DefaultSharedAccess } from "./server-general.js";
import { decryptSecret } from "./secret.js";

export type GrantMode = "all" | "list" | "none";
export interface Grant { mode: GrantMode; models: string[] }

export const GRANT_MODELS_MAX = 500;
export const GRANT_MODEL_MAX_LENGTH = 300;

/** The provider columns these functions read (a providers table row). */
export interface ProviderRowLike {
  id: string;
  user_id: string;
  shared?: number | boolean | null;
  deleted?: number | boolean | null;
}

/** A shared provider as ordinary users see it: no URL, no key, no model. */
export interface SharedProviderView {
  id: string;
  name: string;
  kind: string;
  shared: true;
  readOnly: true;
  allowedModels: "all" | string[];
  /** The default model, or "" when that model is not allowed to this user. */
  model: string;
}

const parseModels = (v: unknown): string[] => {
  if (typeof v !== "string") return [];
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
};

const defaultAccess = (): DefaultSharedAccess => readGeneral().defaultSharedAccess;

/** users.is_admin = 1. */
export function isAdminUser(userId: string): boolean {
  const r = db.prepare("SELECT is_admin FROM users WHERE id = ?").get(userId) as { is_admin: number } | undefined;
  return !!r && Number(r.is_admin) === 1;
}

/** Whether the user exists (not deleted). */
export function userExists(userId: string): boolean {
  return !!db.prepare("SELECT 1 AS ok FROM users WHERE id = ?").get(userId);
}

/** Validates and normalizes a model-ID list: non-empty strings of at most 300 characters, duplicates removed, at most 500. Throws RangeError. */
export function normalizeModels(models: unknown): string[] {
  if (!Array.isArray(models)) throw new RangeError("models must be an array of strings");
  const out = new Set<string>();
  for (const m of models) {
    if (typeof m !== "string" || m.length === 0 || m.length > GRANT_MODEL_MAX_LENGTH) {
      throw new RangeError(`each model must be a string of 1 to ${GRANT_MODEL_MAX_LENGTH} characters`);
    }
    out.add(m);
  }
  if (out.size > GRANT_MODELS_MAX) throw new RangeError(`at most ${GRANT_MODELS_MAX} models`);
  return [...out];
}

/** The user's grant row on the provider, or null (no row: the server default applies). */
export function getGrant(userId: string, providerId: string): Grant | null {
  const r = db.prepare("SELECT mode, models FROM user_model_grants WHERE user_id = ? AND provider_id = ?")
    .get(userId, providerId) as { mode: GrantMode; models: string } | undefined;
  if (!r) return null;
  return { mode: r.mode, models: parseModels(r.models) };
}

/** Inserts or replaces the grant row. "list" needs at least one model; "all" and "none" store no models. Throws RangeError. */
export function setGrant(userId: string, providerId: string, mode: GrantMode, models: unknown = []): void {
  if (mode !== "all" && mode !== "list" && mode !== "none") throw new RangeError("mode must be all, list or none");
  const list = mode === "list" ? normalizeModels(models) : [];
  if (mode === "list" && list.length === 0) throw new RangeError("list needs at least one model");
  db.prepare(
    "INSERT INTO user_model_grants (user_id, provider_id, mode, models, updated_at) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(user_id, provider_id) DO UPDATE SET mode = excluded.mode, models = excluded.models, updated_at = excluded.updated_at",
  ).run(userId, providerId, mode, JSON.stringify(list), Date.now());
}

/** Removes the grant row (the server default applies again). Returns whether a row existed. */
export function deleteGrant(userId: string, providerId: string): boolean {
  return db.prepare("DELETE FROM user_model_grants WHERE user_id = ? AND provider_id = ?").run(userId, providerId).changes > 0;
}

/** Every grant row of one user, for the admin view. */
export function grantsOfUser(userId: string): { providerId: string; mode: GrantMode; models: string[] }[] {
  const rows = db.prepare("SELECT provider_id, mode, models FROM user_model_grants WHERE user_id = ? ORDER BY provider_id")
    .all(userId) as { provider_id: string; mode: GrantMode; models: string }[];
  return rows.map((r) => ({ providerId: r.provider_id, mode: r.mode, models: parseModels(r.models) }));
}

/** Whether the user may use this model on this provider row. */
export function modelAllowed(userId: string, providerRow: ProviderRowLike, model: string): boolean {
  if (!providerRow) return false;
  if (providerRow.user_id === userId) return true;
  if (!providerRow.shared || providerRow.deleted) return false; // never another user's private provider, admin or not (their URL and key stay theirs)
  if (isAdminUser(userId)) return true; // admins are not limited on shared providers
  const g = getGrant(userId, providerRow.id);
  if (g) {
    if (g.mode === "all") return true;
    if (g.mode === "list") return g.models.includes(model);
    return false;
  }
  return defaultAccess() === "all";
}

/** Whether the user can use the provider at all (own, or shared and allowed for at least one model). */
export function providerUsableBy(userId: string, providerRow: ProviderRowLike): boolean {
  if (!providerRow || providerRow.deleted) return false;
  if (providerRow.user_id === userId) return true;
  if (!providerRow.shared) return false;
  if (isAdminUser(userId)) return true;
  const g = getGrant(userId, providerRow.id);
  if (g) return g.mode === "all" || (g.mode === "list" && g.models.length > 0);
  return defaultAccess() === "all";
}

/** The shared providers this user may use, without URLs, keys or models. Empty for admins (they own or see everything already). */
export function listSharedProvidersFor(userId: string): SharedProviderView[] {
  if (isAdminUser(userId)) return [];
  const rows = db.prepare(
    "SELECT id, user_id, name, kind, model, shared, deleted FROM providers WHERE shared = 1 AND deleted = 0 AND kind NOT IN ('dsh-bridge','vscode-bridge') AND user_id <> ? ORDER BY seq",
  ).all(userId) as { id: string; user_id: string; name: string; kind: string; model: string; shared: number; deleted: number }[];
  const out: SharedProviderView[] = [];
  for (const r of rows) {
    if (!providerUsableBy(userId, r)) continue;
    const g = getGrant(userId, r.id);
    const mode = g ? g.mode : defaultAccess();
    const allowedModels: "all" | string[] = g && g.mode === "list" ? g.models : "all";
    if (mode === "none") continue;
    const modelOk = allowedModels === "all" || allowedModels.includes(r.model);
    out.push({ id: r.id, name: r.name, kind: r.kind, shared: true, readOnly: true, allowedModels, model: modelOk ? r.model : "" });
  }
  return out;
}

/** Admin view: every shared, not deleted provider (no URL, no key). */
export function listAllSharedProviders(): { id: string; name: string; kind: string; ownerUserId: string }[] {
  const rows = db.prepare("SELECT id, name, kind, user_id FROM providers WHERE shared = 1 AND deleted = 0 ORDER BY seq")
    .all() as { id: string; name: string; kind: string; user_id: string }[];
  return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, ownerUserId: r.user_id }));
}

/** Deletes every grant row of the user (user deletion). Not called on disable. */
export function removeUserGrants(userId: string): void {
  db.prepare("DELETE FROM user_model_grants WHERE user_id = ?").run(userId);
}

/** Deletes every grant row on the provider (provider deletion). */
export function removeProviderGrants(providerId: string): void {
  db.prepare("DELETE FROM user_model_grants WHERE provider_id = ?").run(providerId);
}

/** The provider row this user may use (own, or a shared one they may use), else undefined. Never another user's private provider. */
export function getUsableProviderRow(userId: string, providerId: unknown): any | undefined {
  if (typeof providerId !== "string" || providerId === "") return undefined;
  const row = getProviderRow(providerId);
  return row && providerUsableBy(userId, row) ? row : undefined;
}

/** Frame that tells connected clients to fetch /sync again (shared providers, grants or defaults changed). */
export const PROVIDERS_CHANGED_FRAME = { type: "providers-changed" } as const;

/** Raw rows of the shared providers this user may use (not their own; empty for admins, who see their own list only). */
export function sharedRowsFor(userId: string): any[] {
  if (isAdminUser(userId)) return [];
  const rows = db.prepare(
    "SELECT * FROM providers WHERE shared = 1 AND deleted = 0 AND kind NOT IN ('dsh-bridge','vscode-bridge') AND user_id <> ? ORDER BY seq",
  ).all(userId) as any[];
  return rows.filter((r) => providerUsableBy(userId, r));
}

/** Removes the owner's URL, key and any URL-looking text from a message shown to another user. */
export function scrubForUser(text: string, row: any): string {
  let out = String(text).replace(/https?:\/\/[^\s"'<>]+/gi, "[url]");
  if (row?.base_url) out = out.split(String(row.base_url)).join("[url]");
  let key = "";
  try { key = decryptSecret(row?.api_key); } catch { key = ""; }
  if (key) out = out.split(key).join("[key]");
  return out;
}

/** A models result as the given user may see it: a shared provider's models filtered by grant, no default model when it is not allowed, and the error scrubbed. Own rows and admin views pass through. */
export function resultForUser<T extends { models: { id: string }[]; defaultModel?: string; error?: string }>(userId: string, row: any, res: T): T {
  if (!row || row.user_id === userId) return res;
  const out: any = { ...res, models: res.models.filter((m) => modelAllowed(userId, row, m.id)) };
  if (res.defaultModel !== undefined && !modelAllowed(userId, row, res.defaultModel)) delete out.defaultModel;
  if (res.error) out.error = scrubForUser(res.error, row);
  return out as T;
}

/** Whether the model may not be used on this row (the caller answers model_not_allowed). */
export function modelDenied(userId: string, providerRow: ProviderRowLike, model: string): boolean {
  return !modelAllowed(userId, providerRow, model);
}
