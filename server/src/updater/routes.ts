// HTTP routes for the update system. All JSON, Bearer auth. Reads: any logged-in user. Mutations: admin only.
// The same operations are mirrored on the loopback-only local-admin API (local-admin.ts).
import type { FastifyInstance, FastifyReply } from "fastify";
import { AuthError, authFromRequest } from "../auth.js";
import { actorOf, recordAudit } from "../admin-core.js";
import { db } from "../db.js";
import { UpdateErr } from "./github.js";
import { parseVersion } from "./semver.js";
import { getUpdateService } from "./service.js";
import { setUpdateSettings, skipVersion, unskipVersion } from "./store.js";
import type { Channel, UpdateErrorCode } from "./types.js";

const CHANNELS: readonly Channel[] = ["stable", "prerelease"];
const MAX_TOKEN_CHARS = 300;

/** HTTP status for an update error code. */
export function updateHttpStatus(code: UpdateErrorCode): number {
  switch (code) {
    case "busy":
    case "unsupported":
      return 409;
    case "not-found":
      return 404;
    case "network":
    case "bad-response":
    case "rate-limited":
    case "unauthorized":
    case "forbidden":
    case "download":
      return 502; // GitHub or the network failed: not the caller's fault
    default:
      return 400;
  }
}

/** Replies with the error body {error, code}. AuthError is rethrown so the global error handler answers it. */
export function sendUpdateError(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof AuthError) throw e;
  if (e instanceof UpdateErr) return reply.code(updateHttpStatus(e.code)).send({ error: e.message, code: e.code });
  const message = e instanceof Error ? e.message : "update failed";
  return reply.code(500).send({ error: message, code: "other" });
}

/** Validates an optional version in a body (leading v allowed). Returns the bare version or throws AuthError 400. */
export function readVersionBody(v: unknown, required = false): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw new AuthError("version is required", 400);
    return undefined;
  }
  if (typeof v !== "string" || !parseVersion(v)) throw new AuthError("version must look like 1.2.3", 400);
  return v.replace(/^v/i, "");
}

function readChannel(v: unknown): Channel | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !CHANNELS.includes(v as Channel)) throw new AuthError("channel must be stable or prerelease", 400);
  return v as Channel;
}

function requireAdmin(req: { headers: Record<string, any> }): string {
  const userId = authFromRequest(req).userId;
  const u = db.prepare("SELECT is_admin FROM users WHERE id = ?").get(userId) as { is_admin: number } | undefined;
  if (!u?.is_admin) throw new AuthError("Admin only", 403);
  return userId;
}

export function registerUpdateRoutes(app: FastifyInstance): void {
  const svc = () => getUpdateService();

  app.get("/update/status", async (req) => {
    const userId = authFromRequest(req).userId;
    const u = db.prepare("SELECT is_admin FROM users WHERE id = ?").get(userId) as { is_admin: number } | undefined;
    return svc().status(!!u?.is_admin);
  });

  app.post("/update/check", async (req, reply) => {
    requireAdmin(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const channel = readChannel(b.channel);
    try {
      return await svc().checkNow({ channel });
    } catch (e) {
      return sendUpdateError(reply, e);
    }
  });

  app.post("/update/apply", async (req, reply) => {
    requireAdmin(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const version = readVersionBody(b.version);
    try {
      const r = await svc().apply(version);
      return reply.code(202).send({ ok: true, phase: r.phase });
    } catch (e) {
      return sendUpdateError(reply, e);
    }
  });

  app.post("/update/skip", async (req) => {
    requireAdmin(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    skipVersion(readVersionBody(b.version, true) as string);
    return svc().status(true);
  });

  app.post("/update/unskip", async (req) => {
    requireAdmin(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    unskipVersion(readVersionBody(b.version, true) as string);
    return svc().status(true);
  });

  app.put("/update/config", async (req) => {
    const userId = requireAdmin(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: { channel?: Channel; checkHours?: number; githubToken?: string | null } = {};
    const channel = readChannel(b.channel);
    if (channel !== undefined) patch.channel = channel;
    if (b.checkHours !== undefined) {
      const h = b.checkHours;
      if (typeof h !== "number" || !Number.isInteger(h) || h < 0 || h > 720) {
        throw new AuthError("checkHours must be a whole number from 0 to 720 (0 = off)", 400);
      }
      patch.checkHours = h;
    }
    if (b.githubToken !== undefined) {
      if (b.githubToken !== null && (typeof b.githubToken !== "string" || b.githubToken.length > MAX_TOKEN_CHARS)) {
        throw new AuthError("githubToken must be a string or null", 400);
      }
      patch.githubToken = b.githubToken as string | null;
    }
    try {
      setUpdateSettings(patch);
    } catch (e) {
      // validation messages from the store never contain the token
      throw new AuthError(e instanceof Error ? e.message : "invalid settings", 400);
    }
    for (const k of Object.keys(patch)) recordAudit(actorOf(userId), "update.config", k, undefined, (patch as Record<string, unknown>)[k]);
    return svc().status(true);
  });

  app.post("/update/ack", async (req) => {
    requireAdmin(req);
    return svc().acknowledge();
  });
}
