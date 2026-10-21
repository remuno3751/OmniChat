import type { FastifyInstance } from "fastify";
import { AuthError, authFromRequest, changeOwnPassword, createDevice, listDevices, revokeDevice } from "./auth.js";
import { recordAudit } from "./admin-core.js";
import { closeDeviceConns } from "./hub.js";
import { closeDeviceBridges } from "./bridges.js";
import { destroyEphemeralForDevice } from "./ephemeral.js";

/** Bridge token creation limit: 10 per user per hour (in memory). */
const TOKEN_MAX = 10;
const TOKEN_WINDOW = 60 * 60_000;
const tokenCreations = new Map<string, number[]>();

/** Strips control characters/newlines, collapses whitespace, trims and clips to 40 chars. Defaults to "PC". */
function sanitizeBridgeName(v: unknown): string {
  if (typeof v !== "string") return "PC";
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40).trim();
  return s || "PC";
}

function revoke(userId: string, deviceId: string): boolean {
  const ok = revokeDevice(userId, deviceId);
  if (ok) {
    closeDeviceConns(userId, deviceId);
    closeDeviceBridges(userId, deviceId);
    destroyEphemeralForDevice(userId, deviceId, "logout");
  }
  return ok;
}

export function registerDevices(app: FastifyInstance): void {
  app.get("/devices", async (req) => {
    const a = authFromRequest(req);
    return { devices: listDevices(a.userId, a.deviceId) };
  });
  app.delete("/devices/:id", async (req) => {
    const a = authFromRequest(req);
    if (!revoke(a.userId, (req.params as any).id)) throw new AuthError("Device not found", 404);
    return { ok: true };
  });
  // Change the caller's own password. Needs the current one; signs out the user's other devices.
  app.post("/auth/password", async (req) => {
    const a = authFromRequest(req);
    const b = (req.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
    const r = await changeOwnPassword(a.userId, a.deviceId, b.currentPassword, b.newPassword, req.ip);
    recordAudit({ id: a.userId, name: r.username }, "user.password", r.username, undefined, "changed (self)");
    return { ok: true, revokedDevices: r.revokedDevices };
  });
  app.post("/auth/logout", async (req) => {
    const a = authFromRequest(req);
    revoke(a.userId, a.deviceId);
    return { ok: true };
  });
  // Mints a device token for the DSH plugin / bridge on the user's PC. The token is returned once and never logged.
  app.post("/bridges/token", async (req) => {
    const a = authFromRequest(req);
    const now = Date.now();
    const recent = (tokenCreations.get(a.userId) ?? []).filter((t) => now - t < TOKEN_WINDOW);
    if (recent.length >= TOKEN_MAX) {
      tokenCreations.set(a.userId, recent);
      throw new AuthError("Too many tokens created, try again later", 429);
    }
    recent.push(now);
    tokenCreations.set(a.userId, recent);
    const vscode = (req.body as any)?.kind === "vscode";
    const name = `${vscode ? "VS Code" : "DSH plugin"} (${sanitizeBridgeName((req.body as any)?.name)})`;
    const { token, deviceId } = vscode ? createDevice(a.userId, name, "vscode-ext") : createDevice(a.userId, name);
    return { token, deviceId, name };
  });
}
