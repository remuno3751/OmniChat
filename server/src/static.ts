import { existsSync, statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { WEB_DIR } from "./config.js";
import { getSearchBackend } from "./search/index.js";
import { getSearchConfig } from "./search/config.js";
import { readGeneral } from "./server-general.js";
import { detectInstall } from "./updater/install-type.js";

/**
 * Content-Security-Policy for the bundled web UI. The Expo export has exactly one inline script (service-worker
 * registration); it is allowed by hash, everything else must come from this origin. Computed from the real index.html.
 */
export function webCsp(): string {
  const hashes: string[] = [];
  try {
    const html = readFileSync(join(WEB_DIR, "index.html"), "utf8");
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      if (m[1].trim()) hashes.push(`'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
    }
  } catch { /* no web UI */ }
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline'", // react-native-web injects <style> at runtime
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' http: https: ws: wss:", // the app talks to the server it is configured with
    "frame-src 'self' http://tauri.localhost tauri://localhost", // the desktop app's own-origin frame (DSH pairing, desktop/launcher/dsh-bridge-frame.js)
    "worker-src 'self'", "manifest-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
  ].join("; ");
}

export const webUiAvailable = () => existsSync(WEB_DIR) && statSync(WEB_DIR).isDirectory();

const API_PREFIXES = [
  "/auth", "/devices", "/apikeys", "/v1", "/sync", "/conversations", "/providers", "/provider-kinds", "/models",
  "/bridges", "/local-servers", "/projects", "/presets", "/settings", "/messages", "/stats", "/usage", "/ping", "/version", "/healthz",
  "/ws", "/bridge", "/update",
];
const isApiPath = (p: string) => API_PREFIXES.some((x) => p === x || p.startsWith(x + "/"));

/** Version of the running bundle: OMNICHAT_BUNDLE_ROOT (set by boot.ts) when present, else this package. */
function pkgVersion(): string {
  try {
    const root = process.env.OMNICHAT_BUNDLE_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..");
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "0.0.0";
  } catch { return "0.0.0"; }
}

export async function registerStatic(app: FastifyInstance): Promise<void> {
  const version = pkgVersion();
  const install = detectInstall();
  app.get("/ping", async () => ({ t: Date.now() }));
  // AGPL-3.0 section 13: users of a network service are offered the corresponding source
  app.get("/version", async () => ({ name: "omnichat-server", version, installType: install.type, selfUpdate: install.selfUpdate, ephemeral: true, adminSettings: true, serverName: readGeneral().serverName, serverDescription: readGeneral().serverDescription, webUi: webUiAvailable(), searxng: !!getSearchConfig().searxngUrl, searchBackend: getSearchBackend()?.name ?? null, license: "AGPL-3.0-only", source: "https://github.com/remuno3751/omnichat" }));
  app.get("/healthz", async (_req, reply) => reply.type("text/plain").send("ok"));

  const web = webUiAvailable();
  if (web) {
    await app.register(fastifyStatic, {
      root: WEB_DIR,
      index: ["index.html"],
      cacheControl: false,
    });
  }
  if (web) {
    app.addHook("onSend", async (req, reply, payload) => {
      if (req.method !== "GET" && req.method !== "HEAD") return payload;
      const path = req.url.split("?")[0];
      if ((path.startsWith("/assets/") || path.startsWith("/_expo/static/")) && reply.statusCode === 200) reply.header("Cache-Control", "public, max-age=31536000, immutable");
      else if (path === "/sw.js" || path === "/manifest.webmanifest") reply.header("Cache-Control", "no-cache");
      else if (!isApiPath(path) && String(reply.getHeader("content-type") ?? "").startsWith("text/html")) reply.header("Cache-Control", "no-cache");
      return payload;
    });
  }
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split("?")[0];
    if (web && (req.method === "GET" || req.method === "HEAD") && !isApiPath(path) && !/\.[a-zA-Z0-9]+$/.test(path)) {
      return reply.header("Cache-Control", "no-cache").type("text/html; charset=utf-8").sendFile("index.html");
    }
    if (path.startsWith("/v1/")) return reply.code(404).send({ error: { message: "Unknown endpoint", type: "invalid_request_error", code: "not_found" } });
    reply.code(404).send({ error: "Not found" });
  });
}
