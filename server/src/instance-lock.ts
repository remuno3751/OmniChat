/* One server per data directory: two servers on the same SQLite file corrupt it, and a launcher that picks a free
   port when 8787 is busy would happily start the second one. The running server writes `server.lock` ("pid port");
   a new one refuses to start while that pid is alive AND its port still answers /healthz (so a recycled pid or a
   crashed server never blocks a start). No db import. */
import { readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";

export interface LockInfo { pid: number; port: number }

/** A live pid with a lock this young is treated as a server that is still starting. */
const BOOTING_MS = 30_000;

export const lockPath = (dataDir: string): string => join(dataDir, "server.lock");

export function parseLock(text: string): LockInfo | null {
  const m = /^(\d+)\s+(\d+)\s*$/.exec(text.trim());
  if (!m) return null;
  const pid = Number(m[1]), port = Number(m[2]);
  return pid > 0 && port > 0 && port < 65536 ? { pid, port } : null;
}

const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

async function answers(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

/** The other live server that owns `dataDir`, or null when the directory is free (no lock, own pid, dead pid, silent port). */
export async function otherServer(dataDir: string, selfPid = process.pid, probe: (port: number) => Promise<boolean> = answers): Promise<LockInfo | null> {
  let info: LockInfo | null;
  try { info = parseLock(readFileSync(lockPath(dataDir), "utf8")); } catch { return null; }
  if (!info || info.pid === selfPid || !pidAlive(info.pid)) return null;
  // a lock written moments ago belongs to a server that is still booting (its port does not answer yet)
  let age = Infinity;
  try { age = Date.now() - statSync(lockPath(dataDir)).mtimeMs; } catch { /* gone */ }
  return age < BOOTING_MS || (await probe(info.port)) ? info : null;
}

export function writeLock(dataDir: string, port: number, pid = process.pid): void {
  try { writeFileSync(lockPath(dataDir), `${pid} ${port}\n`); } catch { /* read-only data dir: the lock is best effort */ }
}

export function removeLock(dataDir: string, pid = process.pid): void {
  try {
    const info = parseLock(readFileSync(lockPath(dataDir), "utf8"));
    if (info?.pid === pid) unlinkSync(lockPath(dataDir));
  } catch { /* already gone */ }
}
