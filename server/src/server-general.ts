/* Server-wide general settings (PROTOCOL-v7-admin.md): server name, description and registration policy.
   The DB value (table server_settings, key "general") wins; ALLOW_REGISTRATION (env) and the built-in name are defaults.
   Imports only db.js and config.js (not auth.js, to avoid a cycle: auth.ts uses registrationAllowed()). */
import { db } from "./db.js";
import { ALLOW_REGISTRATION } from "./config.js";

export const DEFAULT_SERVER_NAME = "OmniChat server";

/** Shared providers (SHARED-PROVIDERS.md): access for a user with no grant row on a shared provider. */
export type DefaultSharedAccess = "none" | "all";

export interface GeneralSettings {
  serverName: string;
  serverDescription: string;
  allowRegistration: boolean;
  allowRegistrationSource: "db" | "env";
  defaultSharedAccess: DefaultSharedAccess;
  /** false: ordinary users cannot add their own providers (admins always can) */
  allowOwnProviders: boolean;
}

export interface GeneralPatch {
  serverName?: string;
  serverDescription?: string;
  allowRegistration?: boolean;
  defaultSharedAccess?: DefaultSharedAccess;
  allowOwnProviders?: boolean;
}

interface Stored {
  serverName?: string;
  serverDescription?: string;
  allowRegistration?: boolean;
  defaultSharedAccess?: DefaultSharedAccess;
  allowOwnProviders?: boolean;
}

const KEY = "general";

function readStored(): Stored {
  try {
    const row = db.prepare("SELECT value FROM server_settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    const j = row ? JSON.parse(row.value) : {};
    return j && typeof j === "object" ? j : {};
  } catch { return {}; }
}

function writeStored(s: Stored): void {
  db.prepare("INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(KEY, JSON.stringify(s), Date.now());
}

/** The effective general settings: DB value, else env default, else built-in default. */
export function readGeneral(): GeneralSettings {
  const s = readStored();
  const name = typeof s.serverName === "string" ? s.serverName.trim() : "";
  const reg = s.allowRegistration;
  const fromDb = typeof reg === "boolean";
  return {
    serverName: name || DEFAULT_SERVER_NAME,
    serverDescription: typeof s.serverDescription === "string" ? s.serverDescription : "",
    allowRegistration: fromDb ? reg : ALLOW_REGISTRATION,
    allowRegistrationSource: fromDb ? "db" : "env",
    defaultSharedAccess: s.defaultSharedAccess === "all" ? "all" : "none",
    allowOwnProviders: typeof s.allowOwnProviders === "boolean" ? s.allowOwnProviders : true,
  };
}

/** Merges the given fields into the stored value. Validation is the caller's job (see admin-core.ts updateGeneral). */
export function writeGeneralRaw(patch: GeneralPatch): void {
  const s = readStored();
  if (patch.serverName !== undefined) s.serverName = patch.serverName;
  if (patch.serverDescription !== undefined) s.serverDescription = patch.serverDescription;
  if (patch.allowRegistration !== undefined) s.allowRegistration = patch.allowRegistration;
  if (patch.defaultSharedAccess !== undefined) s.defaultSharedAccess = patch.defaultSharedAccess;
  if (patch.allowOwnProviders !== undefined) s.allowOwnProviders = patch.allowOwnProviders;
  writeStored(s);
}

export function registrationAllowed(): boolean {
  return readGeneral().allowRegistration;
}
