// Provider API keys are stored encrypted (AES-256-GCM) so a copied database or backup does not expose them.
// Master key: OMNICHAT_SECRET_KEY (any string of 16+ chars) or, when unset, a random key kept in DATA_DIR/secret.key
// (mode 0600, created on first use). Keep the key file out of the places you copy backups to.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DATA_DIR, DB_PATH } from "./config.js";

const PREFIX = "enc1:";
let cached: Buffer | null = null;

function masterKey(): Buffer {
  if (cached) return cached;
  const fromEnv = process.env.OMNICHAT_SECRET_KEY;
  if (fromEnv && fromEnv.length >= 16) {
    cached = scryptSync(fromEnv, "omnichat-secret-v1", 32);
  } else if (DB_PATH === ":memory:") {
    cached = randomBytes(32);
  } else {
    const file = join(DATA_DIR, "secret.key");
    if (existsSync(file)) {
      cached = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
      if (cached.length !== 32) throw new Error(`${file} is not a 32-byte hex key`);
    } else {
      mkdirSync(dirname(file), { recursive: true });
      cached = randomBytes(32);
      writeFileSync(file, cached.toString("hex") + "\n", { mode: 0o600, flag: "wx" });
    }
  }
  return cached;
}

export const isEncrypted = (s: string): boolean => s.startsWith(PREFIX);

export function encryptSecret(plain: string): string {
  if (!plain || isEncrypted(plain)) return plain;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

/** Plain legacy values pass through; an undecryptable value (wrong/missing master key) yields "" and a warning. */
export function decryptSecret(stored: string | null | undefined): string {
  if (!stored) return "";
  if (!isEncrypted(stored)) return stored;
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), "base64");
    const d = createDecipheriv("aes-256-gcm", masterKey(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    console.error("could not decrypt a provider API key (wrong or missing OMNICHAT_SECRET_KEY / secret.key?)");
    return "";
  }
}

/** One-time upgrade of keys stored in plain text by earlier versions. */
export function encryptExistingKeys(db: DatabaseSync): void {
  const rows = db.prepare("SELECT id, api_key FROM providers WHERE api_key != '' AND api_key NOT LIKE 'enc1:%'").all() as Array<{ id: string; api_key: string }>;
  if (!rows.length) return;
  const upd = db.prepare("UPDATE providers SET api_key = ? WHERE id = ?");
  for (const r of rows) upd.run(encryptSecret(r.api_key), r.id);
}
