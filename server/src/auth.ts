import { grantDefaults } from "./tools/approvals.js";
import { randomBytes, scrypt, timingSafeEqual, randomUUID } from "node:crypto";
import { db } from "./db.js";
import { sha256 } from "./migrate-auth.js";
import { OPEN_FIRST_REGISTRATION } from "./config.js";
import { registrationAllowed } from "./server-general.js";

export class AuthError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export interface AuthResult { userId: string; username: string; token: string; deviceId: string; isAdmin: boolean }
export interface Device { id: string; name: string; platform: string; createdAt: number; lastSeenAt: number; current: boolean }

// Async on purpose: scrypt takes ~50 ms of CPU, and scryptSync would stall every other request while it runs.
function hashPassword(password: string, salt: string): Promise<string> {
  return new Promise((res, rej) => scrypt(password, salt, 64, (err, key) => (err ? rej(err) : res(key.toString("hex")))));
}
const DUMMY_SALT = randomBytes(16).toString("hex");

const clip = (v: unknown, fallback: string, n = 100) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, n) : fallback;

function newDevice(userId: string, nameIn: unknown, platformIn: unknown): { token: string; deviceId: string } {
  const token = randomBytes(32).toString("hex");
  const deviceId = randomUUID();
  const now = Date.now();
  db.prepare(
    "INSERT INTO devices (id, user_id, name, platform, token_hash, created_at, last_seen_at) VALUES (?,?,?,?,?,?,?)",
  ).run(deviceId, userId, clip(nameIn, "Unknown device"), clip(platformIn, "", 40), sha256(token), now, now);
  return { token, deviceId };
}

/** Creates a device token for an already-authenticated user (e.g. the DSH plugin). The token is stored hashed. */
export function createDevice(userId: string, name: string, platform = "dsh-plugin"): { token: string; deviceId: string } {
  return newDevice(userId, name, platform);
}

function validate(username: unknown, password: unknown): { username: string; password: string } {
  if (typeof username !== "string" || typeof password !== "string") throw new AuthError("username and password required");
  const u = username.trim();
  if (u.length < 3 || u.length > 32) throw new AuthError("Username must be 3-32 characters");
  if (password.length < 8) throw new AuthError("Password must be at least 8 characters");
  return { username: u, password };
}

function checkRegistrationOpen(userCount: number): void {
  if (userCount === 0) {
    if (!OPEN_FIRST_REGISTRATION) {
      throw new AuthError("No administrator exists yet. Create one with the OmniChat server app or `node dist/admin-cli.js create` on the server machine.", 403);
    }
  } else if (!registrationAllowed()) {
    throw new AuthError("registration is disabled", 403);
  }
}

/** Creates an account directly (local admin API / admin CLI): no registration policy, no device. */
export async function createUserDirect(usernameIn: unknown, passwordIn: unknown, isAdmin: boolean): Promise<{ userId: string; username: string; isAdmin: boolean }> {
  const { username, password } = validate(usernameIn, passwordIn);
  const salt = randomBytes(16).toString("hex");
  const hash = await hashPassword(password, salt);
  if (db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(username)) throw new AuthError("Username already taken", 409);
  const id = randomUUID();
  db.prepare("INSERT INTO users (id, username, salt, hash, created_at, is_admin) VALUES (?,?,?,?,?,?)").run(id, username, salt, hash, Date.now(), isAdmin ? 1 : 0);
  grantDefaults(id);
  return { userId: id, username, isAdmin };
}

/** New password for an existing user; every device of that user is signed out. */
export async function setPassword(userId: string, passwordIn: unknown): Promise<void> {
  if (typeof passwordIn !== "string" || passwordIn.length < 8) throw new AuthError("Password must be at least 8 characters");
  const salt = randomBytes(16).toString("hex");
  const hash = await hashPassword(passwordIn, salt);
  db.prepare("UPDATE users SET salt = ?, hash = ? WHERE id = ?").run(salt, hash, userId);
  db.prepare("UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(Date.now(), userId);
}

export async function register(usernameIn: unknown, passwordIn: unknown, deviceName?: unknown, platform?: unknown): Promise<AuthResult> {
  const { username, password } = validate(usernameIn, passwordIn);
  const count = (db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c;
  checkRegistrationOpen(count);
  if (db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(username)) {
    throw new AuthError("Username already taken", 409);
  }
  const id = randomUUID();
  const salt = randomBytes(16).toString("hex");
  const hash = await hashPassword(password, salt);
  // re-check after the await: another registration may have completed meanwhile (first user = admin, name uniqueness)
  const countNow = (db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c;
  checkRegistrationOpen(countNow);
  if (db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(username)) throw new AuthError("Username already taken", 409);
  const isAdmin = countNow === 0;
  db.prepare("INSERT INTO users (id, username, salt, hash, created_at, is_admin) VALUES (?,?,?,?,?,?)").run(
    id, username, salt, hash, Date.now(), isAdmin ? 1 : 0,
  );
  grantDefaults(id);
  return { userId: id, username, isAdmin, ...newDevice(id, deviceName, platform) };
}

// Failed-login limiter (in memory): 10 failures per 5 minutes per ip+username, plus a high per-username cap across all
// IPs (distributed guessing). The cap is deliberately far above what one person mistypes.
const FAIL_MAX = 10;
const FAIL_MAX_PER_USER = 100;
const FAIL_WINDOW = 5 * 60_000;
const failures = new Map<string, number[]>();
setInterval(() => { for (const k of [...failures.keys()]) recent(k); }, FAIL_WINDOW).unref();
function recent(k: string): number[] {
  const now = Date.now();
  const arr = (failures.get(k) ?? []).filter((t) => now - t < FAIL_WINDOW);
  if (arr.length) failures.set(k, arr); else failures.delete(k);
  return arr;
}

export async function login(usernameIn: unknown, passwordIn: unknown, deviceName?: unknown, platform?: unknown, ip = ""): Promise<AuthResult> {
  if (typeof usernameIn !== "string" || typeof passwordIn !== "string") throw new AuthError("username and password required");
  const uname = usernameIn.trim().toLowerCase();
  const fk = `${ip}\u0000${uname}`;
  const uk = `user\u0000${uname}`;
  if (recent(fk).length >= FAIL_MAX || recent(uk).length >= FAIL_MAX_PER_USER) throw new AuthError("Too many failed login attempts, try again later", 429);
  const fail = (): never => {
    for (const k of [fk, uk]) {
      const arr = recent(k);
      arr.push(Date.now());
      failures.set(k, arr);
    }
    throw new AuthError("Invalid username or password", 401);
  };
  const row = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(usernameIn.trim()) as
    | { id: string; username: string; salt: string; hash: string; is_admin: number; disabled_at: number | null }
    | undefined;
  if (!row || row.disabled_at) {
    await hashPassword(passwordIn, DUMMY_SALT); // same work as a real check, so response time does not reveal which names exist
    return fail();
  }
  const a = Buffer.from(await hashPassword(passwordIn, row.salt), "hex");
  const b = Buffer.from(row.hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return fail();
  failures.delete(fk);
  return { userId: row.id, username: row.username, isAdmin: !!row.is_admin, ...newDevice(row.id, deviceName, platform) };
}

/**
 * The signed-in user changes their own password: the current one is checked (with the same failure limiter as login), every other device
 * of the user is signed out and the calling device stays. Returns how many other devices were signed out.
 */
export async function changeOwnPassword(userId: string, keepDeviceId: string, currentIn: unknown, newIn: unknown, ip = ""): Promise<{ revokedDevices: number; username: string }> {
  if (typeof currentIn !== "string" || typeof newIn !== "string") throw new AuthError("currentPassword and newPassword required", 400);
  if (newIn.length < 8) throw new AuthError("Password must be at least 8 characters", 400);
  const row = db.prepare("SELECT username, salt, hash FROM users WHERE id = ?").get(userId) as { username: string; salt: string; hash: string } | undefined;
  if (!row) throw new AuthError("User not found", 404);
  const uname = row.username.toLowerCase();
  const fk = `${ip} ${uname}`;
  const uk = `user ${uname}`;
  if (recent(fk).length >= FAIL_MAX || recent(uk).length >= FAIL_MAX_PER_USER) throw new AuthError("Too many failed attempts, try again later", 429);
  const a = Buffer.from(await hashPassword(currentIn, row.salt), "hex");
  const b = Buffer.from(row.hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    for (const k of [fk, uk]) { const arr = recent(k); arr.push(Date.now()); failures.set(k, arr); }
    throw new AuthError("Current password is wrong", 403);
  }
  failures.delete(fk);
  const others = Number((db.prepare("SELECT COUNT(*) AS n FROM devices WHERE user_id = ? AND revoked_at IS NULL AND id <> ?").get(userId, keepDeviceId) as { n: number }).n);
  await setPassword(userId, newIn); // signs out every device ...
  db.prepare("UPDATE devices SET revoked_at = NULL WHERE id = ? AND user_id = ?").run(keepDeviceId, userId); // ... except the one asking
  return { revokedDevices: others, username: row.username };
}

const SEEN_EVERY = 60_000;
export function deviceFromToken(token: string | undefined | null): { userId: string; deviceId: string; username: string } | null {
  if (!token) return null;
  const row = db
    .prepare(
      "SELECT d.id AS did, d.last_seen_at AS seen, u.id AS uid, u.username AS username FROM devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ? AND d.revoked_at IS NULL AND u.disabled_at IS NULL",
    )
    .get(sha256(token)) as { did: string; seen: number; uid: string; username: string } | undefined;
  if (!row) return null;
  const now = Date.now();
  if (now - row.seen >= SEEN_EVERY) db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, row.did);
  return { userId: row.uid, deviceId: row.did, username: row.username };
}

export function userFromToken(token: string | undefined | null): { userId: string; username: string } | null {
  const d = deviceFromToken(token);
  return d ? { userId: d.userId, username: d.username } : null;
}

export function listDevices(userId: string, currentDeviceId: string | null): Device[] {
  return (db.prepare("SELECT * FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at").all(userId) as any[]).map((r) => ({
    id: r.id, name: r.name, platform: r.platform, createdAt: r.created_at, lastSeenAt: r.last_seen_at, current: r.id === currentDeviceId,
  }));
}

/** Revokes the device; returns false if it does not exist / is not the user's / already revoked. */
export function revokeDevice(userId: string, deviceId: string): boolean {
  const r = db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").run(Date.now(), deviceId, userId);
  return Number(r.changes) > 0;
}

/** Resolves the Bearer device token of a request (401 AuthError if missing/invalid/revoked). */
export function authFromRequest(req: { headers: Record<string, any> }): { userId: string; deviceId: string; username: string } {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""));
  const d = deviceFromToken(m?.[1]?.trim());
  if (!d) throw new AuthError("Unauthorized", 401);
  return d;
}
