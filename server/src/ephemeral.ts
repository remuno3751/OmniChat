/* eslint-disable @typescript-eslint/no-explicit-any */
// Ephemeral chats: registry (in memory), lifetime rules (idle sweep, device grace, logout) and row destruction.
// Rows live in the in-memory schema `eph` (see db.ts); see docs/EPHEMERAL.md and docs/PROTOCOL-v7-ephemeral.md.
import { db, rawDb, runEphemeral, toConversation, toMessage } from "./db.js";
import { AuthError } from "./auth.js";
import { broadcast, deviceConnCount } from "./hub.js";
import { getSettings } from "./projects.js";

export const EPH_PREFIX = "eph_";
export type DestroyReason = "ended" | "idle" | "logout" | "disconnected" | "limit";
export interface EphInfo { id: string; userId: string; deviceId: string; createdAt: number; lastActive: number }

const MAX_LIVE_PER_USER = 5;

export const isEphemeralId = (id: unknown): id is string => typeof id === "string" && id.startsWith(EPH_PREFIX);
export { runEphemeral } from "./db.js";

const live = new Map<string, EphInfo>();
const destroyListeners: ((id: string) => void)[] = [];
const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

const envMs = (name: string): number | null => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const graceMs = (): number => envMs("OMNICHAT_EPHEMERAL_GRACE_MS") ?? 120_000;
const sweepMs = (): number => Math.max(10, envMs("OMNICHAT_EPHEMERAL_SWEEP_MS") ?? 15_000);
const devKey = (userId: string, deviceId: string): string => `${userId}\u0000${deviceId}`;

export function registerEphemeral(userId: string, deviceId: string, id: string): EphInfo {
  if (!isEphemeralId(id)) throw new AuthError("Invalid ephemeral chat id", 400);
  const cur = live.get(id);
  if (cur) {
    if (cur.userId !== userId) throw new AuthError("Conversation id in use", 409);
    return cur;
  }
  let n = 0;
  for (const e of live.values()) if (e.userId === userId) n++;
  if (n >= MAX_LIVE_PER_USER) throw new AuthError("Too many ephemeral chats", 429);
  const now = Date.now();
  const info: EphInfo = { id, userId, deviceId, createdAt: now, lastActive: now };
  live.set(id, info);
  return info;
}

export function getEphemeral(id: string): EphInfo | undefined {
  return live.get(id);
}

export function isLiveEphemeral(userId: string, id: string): boolean {
  return live.get(id)?.userId === userId;
}

export function touchEphemeral(id: string): void {
  const info = live.get(id);
  if (info) info.lastActive = Date.now();
}

export function destroyEphemeral(id: string, reason: DestroyReason): boolean {
  const info = live.get(id);
  if (!info) return false;
  for (const fn of destroyListeners) {
    try { fn(id); } catch { /* a listener must not block destruction */ }
  }
  live.delete(id);
  let messages = 0;
  try {
    runEphemeral(() => {
      messages = (db.prepare("SELECT count(*) AS n FROM messages WHERE conversation_id = ?").get(id) as any)?.n ?? 0;
      db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
      db.prepare("DELETE FROM metrics WHERE conversation_id = ?").run(id);
      db.prepare("DELETE FROM checkpoints WHERE conversation_id = ?").run(id);
      db.prepare("DELETE FROM agent_sessions WHERE conversation_id = ?").run(id);
      db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
    });
  } catch (e) {
    console.error(`ephemeral: row delete failed (${(e as Error).name})`);
  }
  console.log(`ephemeral: destroyed (${reason}), ${messages} messages`);
  broadcast(info.userId, { type: "ephemeral_destroyed", conversationId: id, reason });
  if (live.size === 0) {
    try { rawDb.exec("VACUUM eph"); } catch { /* best effort */ }
  }
  return true;
}

function destroyWhere(pred: (e: EphInfo) => boolean, reason: DestroyReason): number {
  let n = 0;
  for (const e of [...live.values()]) if (pred(e) && destroyEphemeral(e.id, reason)) n++;
  return n;
}

export function destroyEphemeralForDevice(userId: string, deviceId: string, reason: DestroyReason): number {
  return destroyWhere((e) => e.userId === userId && e.deviceId === deviceId, reason);
}

export function destroyEphemeralForUser(userId: string, reason: DestroyReason): number {
  return destroyWhere((e) => e.userId === userId, reason);
}

export function listLiveEphemeral(userId: string): string[] {
  const out: string[] = [];
  for (const e of live.values()) if (e.userId === userId) out.push(e.id);
  return out;
}

/** Listeners run before the rows are deleted (chat.ts aborts running generation here). */
export function onEphemeralDestroy(fn: (id: string) => void): void {
  destroyListeners.push(fn);
}

export function onEphemeralDeviceConnect(userId: string, deviceId: string): void {
  const key = devKey(userId, deviceId);
  const t = graceTimers.get(key);
  if (t) { clearTimeout(t); graceTimers.delete(key); }
}

export function onEphemeralDeviceDisconnect(userId: string, deviceId: string): void {
  if (deviceConnCount(userId, deviceId) !== 0) return;
  const owns = [...live.values()].some((e) => e.userId === userId && e.deviceId === deviceId);
  if (!owns) return;
  const key = devKey(userId, deviceId);
  if (graceTimers.has(key)) return;
  const t = setTimeout(() => {
    graceTimers.delete(key);
    if (deviceConnCount(userId, deviceId) !== 0) return;
    destroyEphemeralForDevice(userId, deviceId, "disconnected");
  }, graceMs());
  t.unref();
  graceTimers.set(key, t);
}

export function ephemeralStateFrame(userId: string): { type: "ephemeral_state"; conversations: unknown[]; messages: unknown[]; idleMinutes: number } {
  const ids = listLiveEphemeral(userId);
  const idleMinutes = getSettings(userId).ephemeralIdleMinutes;
  return runEphemeral(() => {
    const conversations: unknown[] = [];
    const messages: unknown[] = [];
    for (const id of ids) {
      const row = db.prepare("SELECT * FROM conversations WHERE id = ?").get(id);
      if (!row) continue;
      conversations.push(toConversation(row));
      const rows = db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, seq").all(id);
      for (const r of rows) messages.push(toMessage(r));
    }
    return { type: "ephemeral_state" as const, conversations, messages, idleMinutes };
  });
}

function sweepIdle(): void {
  try {
    if (live.size === 0) return;
    const now = Date.now();
    const fixed = envMs("OMNICHAT_EPHEMERAL_IDLE_MS");
    const idleByUser = new Map<string, number>();
    for (const info of [...live.values()]) {
      let limit = fixed;
      if (limit === null) {
        let m = idleByUser.get(info.userId);
        if (m === undefined) {
          m = getSettings(info.userId).ephemeralIdleMinutes;
          idleByUser.set(info.userId, m);
        }
        limit = m * 60_000;
      }
      if (now - info.lastActive > limit) destroyEphemeral(info.id, "idle");
    }
  } catch (e) {
    console.error(`ephemeral: sweep failed (${(e as Error).name})`);
  }
}

export function startEphemeralSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepIdle, sweepMs());
  sweepTimer.unref();
}
