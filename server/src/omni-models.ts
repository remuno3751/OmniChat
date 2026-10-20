// PROTOCOL v7 section 2.1: the OmniChat models and per-device API keys that a dsh plugin imports over its bridge.
import { db } from "./db.js";
import { modelsForProvider } from "./models.js";
import { providerSlug } from "./openai-api.js";
import { createApiKey, revokeApiKey } from "./apikeys.js";

export interface OmniModel { id: string; name: string; providerName: string; contextWindow?: number }

/** Key names minted for dsh imports; revokeDshKey only touches keys with this prefix. */
export const DSH_KEY_PREFIX = "DSH import";
const MAX_MODELS = 500;

function providers(userId: string): any[] {
  return db.prepare("SELECT * FROM providers WHERE user_id = ? AND deleted = 0 AND kind = 'openai-compatible' ORDER BY created_at, seq").all(userId) as any[];
}

const positiveInt = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);

/** Chat models of the user's openai-compatible providers, as offered on /v1/models. Never throws for one failing provider. */
export async function listOmniModels(userId: string): Promise<OmniModel[]> {
  const per = await Promise.all(providers(userId).map(async (row): Promise<OmniModel[]> => {
    try {
      const slug = providerSlug(row.name);
      const res = await modelsForProvider(row, false, false);
      return res.models.map((m) => {
        const cw = positiveInt(m.state?.contextLength) ?? positiveInt(m.state?.loadedContextLength);
        return { id: `${slug}/${m.id}`, name: m.id, providerName: String(row.name), ...(cw ? { contextWindow: cw } : {}) };
      });
    } catch {
      return [];
    }
  }));
  return per.flat().sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_MODELS);
}

/** Mints a `/v1` API key for a dsh import. The plain key is returned once; it is never logged or stored in clear. */
export function mintDshKey(userId: string, bridgeName: string): { id: string; key: string } {
  const row = createApiKey(userId, `${DSH_KEY_PREFIX} (${String(bridgeName).slice(0, 60)})`);
  return { id: row.id, key: row.key };
}

/** Revokes a key minted by mintDshKey. False when the key does not exist, is not this user's, or is not a DSH import key. */
export function revokeDshKey(userId: string, keyId: string): boolean {
  if (typeof keyId !== "string" || !keyId) return false;
  const row = db.prepare("SELECT name FROM api_keys WHERE id = ? AND user_id = ? AND deleted = 0").get(keyId, userId) as { name: string } | undefined;
  if (!row || !String(row.name).startsWith(DSH_KEY_PREFIX)) return false;
  return revokeApiKey(userId, keyId);
}
