import { join, resolve } from "node:path";

const env = process.env;
export const PORT = Number(env.PORT ?? 8787);
export const HOST = env.HOST ?? "0.0.0.0";
export const DATA_DIR = env.DATA_DIR ?? "./data";
export const DB_PATH = env.DB_PATH ?? join(DATA_DIR, "omnichat.db");
export const WEB_DIR = resolve(env.WEB_DIR ?? "./web");
export const ALLOW_REGISTRATION = env.ALLOW_REGISTRATION === "1" || env.ALLOW_REGISTRATION === "true";
/**
 * Security: the very first account (the administrator) is NOT created through the open /auth/register endpoint
 * (whoever reaches the port first would become admin). It is created locally: server app, `node dist/admin-cli.js`
 * or the loopback-only /local-admin API. Set OMNICHAT_OPEN_FIRST_REGISTRATION=1 to restore the old behaviour
 * (used by the test suite).
 */
export const OPEN_FIRST_REGISTRATION = env.OMNICHAT_OPEN_FIRST_REGISTRATION === "1";
export const SEARXNG_URL = env.SEARXNG_URL ?? "";
export const EFFORT_MAP = env.EFFORT_MAP ?? join(DATA_DIR, "effort-map.json");
/** Comma-separated allowed origins; empty = permissive (dev). */
export const CORS_ORIGIN = (env.CORS_ORIGIN ?? "").split(",").map((s) => s.trim()).filter(Boolean);
/** Trust X-Forwarded-For (reverse proxy) when classifying the connection route in the WS hello. */
export const TRUST_PROXY = env.TRUST_PROXY === "1" || env.TRUST_PROXY === "true";
