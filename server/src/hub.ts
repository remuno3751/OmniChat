import type { WebSocket } from "ws";

const conns = new Map<string, Set<WebSocket>>();

const deviceOf = new WeakMap<WebSocket, string>();

/** Close every WS connection of a revoked device (code 4001). */
export function closeDeviceConns(userId: string, deviceId: string): void {
  for (const ws of [...(conns.get(userId) ?? [])]) {
    if (deviceOf.get(ws) === deviceId) { try { ws.close(4001, "device revoked"); } catch { /* ignore */ } }
  }
}

export function addConn(userId: string, ws: WebSocket, deviceId?: string): void {
  if (deviceId) deviceOf.set(ws, deviceId);
  let s = conns.get(userId);
  if (!s) conns.set(userId, (s = new Set()));
  s.add(ws);
}

export function removeConn(userId: string, ws: WebSocket): void {
  const s = conns.get(userId);
  if (!s) return;
  s.delete(ws);
  if (s.size === 0) conns.delete(userId);
}

export function broadcast(userId: string, payload: unknown): void {
  const s = conns.get(userId);
  if (!s) return;
  const data = JSON.stringify(payload);
  for (const ws of s) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

/** Every open /ws connection of every user (e.g. maintenance state changes). */
export function broadcastAll(payload: unknown): void {
  const data = JSON.stringify(payload);
  for (const s of conns.values()) {
    for (const ws of s) if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

/** Open /ws connections of one device of a user. */
export function deviceConnCount(userId: string, deviceId: string): number {
  let n = 0;
  for (const ws of conns.get(userId) ?? []) if (deviceOf.get(ws) === deviceId) n++;
  return n;
}

/** Number of open /ws connections (all users). */
export function connectionCount(): number {
  let n = 0;
  for (const s of conns.values()) n += s.size;
  return n;
}

/** Users with at least one open /ws connection. */
export function connectedUserIds(): string[] {
  return [...conns.keys()];
}

export function sendTo(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}
