import type { FastifyInstance } from "fastify";
import { db } from "./db.js";
import { AuthError, authFromRequest } from "./auth.js";

// Pets (PROTOCOL-v4.md section 9): per-user imported Codex pets. Sprite-sheet pets live in the `pets` table.
// "Stills" pets (one image per state) live in `pet_stills` (one row per state) with one row per pet in `pet_stills_meta`.

const MAX_SHEET_BYTES = 8 * 1024 * 1024;
const MAX_B64_CHARS = Math.ceil(MAX_SHEET_BYTES / 3) * 4;
const MAX_PETS = 50;
const BODY_LIMIT = 16 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MIMES = ["image/png", "image/webp"] as const;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EXPECTED_SIZE: Record<1 | 2, { width: number; height: number }> = {
  1: { width: 1536, height: 1872 },
  2: { width: 1536, height: 2288 },
};
const STILL_STATES = ["idle", "thinking", "working", "tool", "done", "error"] as const;
type StillState = (typeof STILL_STATES)[number];
const STILL_MAX_BYTES = 600 * 1024;
const STILL_MAX_B64 = Math.ceil(STILL_MAX_BYTES / 3) * 4;
const STILL_TOTAL_BYTES = 3 * 1024 * 1024;
const STILL_MIN_DIM = 16;
const STILL_MAX_DIM = 1024;

const dbId = (userId: string, petId: string) => `${userId}:${petId}`;
const bad = (msg: string) => new AuthError(msg, 400);
const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Pixel size read from a PNG (IHDR) or WebP (VP8 / VP8L / VP8X) header. Null when the bytes are not a valid image of `mime`. */
export function readSheetSize(buf: Buffer, mime: string): { width: number; height: number } | null {
  if (mime === "image/png") {
    if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG) || buf.toString("latin1", 12, 16) !== "IHDR") return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (mime === "image/webp") {
    if (buf.length < 30 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WEBP") return null;
    const fourcc = buf.toString("latin1", 12, 16);
    if (fourcc === "VP8 ") {
      // lossy: 14-bit dimensions after the 3-byte frame tag and 3-byte start code
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (fourcc === "VP8L") {
      // lossless: signature byte 0x2f, then 14-bit width-1 and height-1 packed in a uint32
      if (buf[20] !== 0x2f) return null;
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (fourcc === "VP8X") {
      // extended: 24-bit canvas width-1 and height-1
      return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    }
    return null;
  }
  return null;
}

function parseManifest(v: unknown) {
  if (!isObj(v)) throw bad("manifest must be an object");
  if (typeof v.id !== "string" || !ID_RE.test(v.id)) throw bad("manifest.id must match [A-Za-z0-9._-]{1,64}");
  const displayName = typeof v.displayName === "string" ? v.displayName.trim() : "";
  if (!displayName || displayName.length > 100) throw bad("manifest.displayName must be a non-empty string of at most 100 characters");
  let description = "";
  if (v.description !== undefined && v.description !== null) {
    if (typeof v.description !== "string" || v.description.length > 500) throw bad("manifest.description must be a string of at most 500 characters");
    description = v.description;
  }
  if (v.spriteVersionNumber !== 1 && v.spriteVersionNumber !== 2) throw bad("manifest.spriteVersionNumber must be 1 or 2");
  if (typeof v.spritesheetPath !== "string" || v.spritesheetPath.length > 300) throw bad("manifest.spritesheetPath must be a string of at most 300 characters");
  return {
    id: v.id as string,
    displayName,
    description,
    spriteVersionNumber: v.spriteVersionNumber as 1 | 2,
    spritesheetPath: v.spritesheetPath as string,
  };
}

function parseStillsBody(b: Record<string, any>) {
  if (typeof b.id !== "string" || !ID_RE.test(b.id)) throw bad("id must match [A-Za-z0-9._-]{1,64}");
  const displayName = typeof b.displayName === "string" ? b.displayName.trim() : "";
  if (!displayName || displayName.length > 100) throw bad("displayName must be a non-empty string of at most 100 characters");
  let description = "";
  if (b.description !== undefined && b.description !== null) {
    if (typeof b.description !== "string" || b.description.length > 500) throw bad("description must be a string of at most 500 characters");
    description = b.description;
  }
  if (!isObj(b.images)) throw bad("images must be an object");
  for (const k of Object.keys(b.images)) {
    if (!(STILL_STATES as readonly string[]).includes(k)) throw bad(`unknown state "${k}"; allowed: ${STILL_STATES.join(", ")}`);
  }
  if (b.images.idle === undefined || b.images.idle === null) throw bad("images.idle is required");

  const images: { state: StillState; mime: string; data: Buffer }[] = [];
  let total = 0;
  for (const state of STILL_STATES) {
    const img = b.images[state];
    if (img === undefined || img === null) continue;
    if (!isObj(img)) throw bad(`images.${state} must be an object`);
    const mime = img.mime;
    if (typeof mime !== "string" || !(MIMES as readonly string[]).includes(mime)) throw bad(`images.${state}.mime must be image/png or image/webp`);
    if (typeof img.dataBase64 !== "string" || img.dataBase64.length > STILL_MAX_B64) {
      throw bad(`images.${state}.dataBase64 must be a base64 string of at most 600 KiB decoded`);
    }
    const data = Buffer.from(img.dataBase64, "base64");
    if (data.length === 0) throw bad(`images.${state} is empty`);
    if (data.length > STILL_MAX_BYTES) throw bad(`images.${state} exceeds 600 KiB`);
    const size = readSheetSize(data, mime);
    if (!size) throw bad(`images.${state} is not a valid ${mime} image`);
    if (size.width < STILL_MIN_DIM || size.height < STILL_MIN_DIM || size.width > STILL_MAX_DIM || size.height > STILL_MAX_DIM) {
      throw bad(`images.${state} must be ${STILL_MIN_DIM}..${STILL_MAX_DIM} px per side, got ${size.width}x${size.height}`);
    }
    total += data.length;
    images.push({ state, mime, data });
  }
  if (total > STILL_TOTAL_BYTES) throw bad("a stills pet may use at most 3 MiB in total");
  return { id: b.id as string, displayName, description, images };
}

/** Removes a user's stills pet (its meta and state rows). Returns 1 when the pet existed, else 0. */
function deleteStills(userId: string, petId: string): number {
  db.prepare("DELETE FROM pet_stills WHERE user_id = ? AND pet_id = ?").run(userId, petId);
  return Number(db.prepare("DELETE FROM pet_stills_meta WHERE user_id = ? AND pet_id = ?").run(userId, petId).changes);
}

const countPets = (userId: string): number => {
  const a = db.prepare("SELECT COUNT(*) AS n FROM pets WHERE user_id = ?").get(userId) as { n: number };
  const b = db.prepare("SELECT COUNT(*) AS n FROM pet_stills_meta WHERE user_id = ?").get(userId) as { n: number };
  return Number(a.n) + Number(b.n);
};

interface PetItem {
  id: string;
  name: string;
  description: string;
  kind: "sprite" | "stills";
  /** Stills pets report 2 (and the idle mime) so clients that only know sprite pets still parse the list. */
  spriteVersionNumber: 1 | 2;
  mime: string;
  size: number;
  createdAt: number;
  /** Stills pets only: the states that have an image, in canonical order. */
  states?: StillState[];
}

export function registerPetRoutes(app: FastifyInstance): void {
  // ---- import / replace a sprite-sheet pet ----
  app.post("/pets", { bodyLimit: BODY_LIMIT }, async (req) => {
    const userId = authFromRequest(req).userId;
    const b: unknown = req.body ?? {};
    if (!isObj(b)) throw bad("body must be an object");
    const manifest = parseManifest(b.manifest);

    const mime = b.mime;
    if (typeof mime !== "string" || !(MIMES as readonly string[]).includes(mime)) throw bad("mime must be image/png or image/webp");

    if (typeof b.sheetBase64 !== "string" || b.sheetBase64.length > MAX_B64_CHARS) throw bad("sheetBase64 must be a base64 string of at most 8 MiB decoded");
    const sheet = Buffer.from(b.sheetBase64, "base64");
    if (sheet.length === 0) throw bad("sheet is empty");
    if (sheet.length > MAX_SHEET_BYTES) throw bad("sheet exceeds 8 MiB");

    const actual = readSheetSize(sheet, mime);
    if (!actual) throw bad(`sheet is not a valid ${mime} image`);
    const expected = EXPECTED_SIZE[manifest.spriteVersionNumber];
    if (actual.width !== expected.width || actual.height !== expected.height) {
      throw bad(
        `spritesheet for spriteVersionNumber ${manifest.spriteVersionNumber} must be ${expected.width}x${expected.height}, got ${actual.width}x${actual.height}`,
      );
    }

    const key = dbId(userId, manifest.id); // pet ids are per user: two users may import the same pet
    const owner = db.prepare("SELECT 1 AS x FROM pets WHERE id = ?").get(key);
    const stillsOwner = db.prepare("SELECT 1 AS x FROM pet_stills_meta WHERE user_id = ? AND pet_id = ?").get(userId, manifest.id);
    if (!owner && !stillsOwner && countPets(userId) >= MAX_PETS) throw bad(`at most ${MAX_PETS} pets per user`);

    const now = Date.now();
    // Same id as a stills pet of this user: the upload replaces it (one pet per id).
    db.exec("BEGIN");
    try {
      if (stillsOwner) deleteStills(userId, manifest.id);
      db.prepare(
        `INSERT INTO pets (id, user_id, name, manifest, sheet, mime, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, manifest = excluded.manifest, sheet = excluded.sheet,
           mime = excluded.mime, created_at = excluded.created_at`,
      ).run(key, userId, manifest.displayName, JSON.stringify(manifest), sheet, mime, now);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }

    const item: PetItem = {
      id: manifest.id,
      name: manifest.displayName,
      description: manifest.description,
      kind: "sprite",
      spriteVersionNumber: manifest.spriteVersionNumber,
      mime,
      size: sheet.length,
      createdAt: now,
    };
    return item;
  });

  // ---- import / replace a stills pet (one image per state) ----
  app.post("/pets/stills", { bodyLimit: BODY_LIMIT }, async (req) => {
    const userId = authFromRequest(req).userId;
    const b: unknown = req.body ?? {};
    if (!isObj(b)) throw bad("body must be an object");
    const parsed = parseStillsBody(b);

    const existing = db.prepare("SELECT 1 AS x FROM pet_stills_meta WHERE user_id = ? AND pet_id = ?").get(userId, parsed.id);
    const sprite = db.prepare("SELECT 1 AS x FROM pets WHERE id = ?").get(dbId(userId, parsed.id));
    if (!existing && !sprite && countPets(userId) >= MAX_PETS) throw bad(`at most ${MAX_PETS} pets per user`);

    const now = Date.now();
    const total = parsed.images.reduce((n, im) => n + im.data.length, 0);
    // Replacing: the same id (either kind) is overwritten as a whole, so the pet never mixes old and new states.
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM pets WHERE id = ? AND user_id = ?").run(dbId(userId, parsed.id), userId);
      deleteStills(userId, parsed.id);
      db.prepare("INSERT INTO pet_stills_meta (user_id, pet_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)").run(
        userId,
        parsed.id,
        parsed.displayName,
        parsed.description,
        now,
      );
      const ins = db.prepare("INSERT INTO pet_stills (user_id, pet_id, state, mime, data, created_at) VALUES (?, ?, ?, ?, ?, ?)");
      for (const im of parsed.images) ins.run(userId, parsed.id, im.state, im.mime, im.data, now);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }

    const idle = parsed.images.find((im) => im.state === "idle")!;
    const item: PetItem = {
      id: parsed.id,
      name: parsed.displayName,
      description: parsed.description,
      kind: "stills",
      spriteVersionNumber: 2,
      mime: idle.mime,
      size: total,
      createdAt: now,
      states: parsed.images.map((im) => im.state),
    };
    return item;
  });

  // ---- list (no blobs) ----
  app.get("/pets", async (req) => {
    const userId = authFromRequest(req).userId;
    const rows = db
      .prepare("SELECT id, name, manifest, mime, length(sheet) AS size, created_at FROM pets WHERE user_id = ? ORDER BY created_at, id")
      .all(userId) as any[];
    const items: PetItem[] = rows.map((r) => {
      const m = JSON.parse(String(r.manifest));
      return {
        id: String(r.id).slice(userId.length + 1),
        name: String(r.name),
        description: typeof m.description === "string" ? m.description : "",
        kind: "sprite",
        spriteVersionNumber: m.spriteVersionNumber === 2 ? 2 : 1,
        mime: String(r.mime),
        size: Number(r.size),
        createdAt: Number(r.created_at),
      };
    });

    const metas = db
      .prepare("SELECT pet_id, name, description, created_at FROM pet_stills_meta WHERE user_id = ?")
      .all(userId) as { pet_id: string; name: string; description: string; created_at: number }[];
    if (metas.length) {
      const states = db
        .prepare("SELECT pet_id, state, mime, length(data) AS size FROM pet_stills WHERE user_id = ?")
        .all(userId) as { pet_id: string; state: string; mime: string; size: number }[];
      const byPet = new Map<string, { states: StillState[]; idleMime: string; size: number }>();
      for (const s of states) {
        const e = byPet.get(s.pet_id) ?? { states: [], idleMime: "", size: 0 };
        e.states.push(s.state as StillState);
        if (s.state === "idle") e.idleMime = String(s.mime);
        e.size += Number(s.size);
        byPet.set(s.pet_id, e);
      }
      for (const m of metas) {
        const e = byPet.get(m.pet_id);
        if (!e) continue; // a meta row without images cannot be shown
        items.push({
          id: m.pet_id,
          name: String(m.name),
          description: String(m.description ?? ""),
          kind: "stills",
          spriteVersionNumber: 2,
          mime: e.idleMime,
          size: e.size,
          createdAt: Number(m.created_at),
          states: STILL_STATES.filter((st) => e.states.includes(st)),
        });
      }
    }

    items.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { pets: items };
  });

  // ---- sprite sheet binary (sprite pets only; a stills pet has no sheet and gets 404) ----
  app.get("/pets/:id/sheet", async (req, reply) => {
    const userId = authFromRequest(req).userId;
    const id = (req.params as any).id as string;
    const row = db.prepare("SELECT sheet, mime FROM pets WHERE id = ? AND user_id = ?").get(dbId(userId, id), userId) as
      | { sheet: Uint8Array; mime: string }
      | undefined;
    if (!row) throw new AuthError("Pet not found", 404);
    return reply
      .header("Content-Type", row.mime)
      .header("Cache-Control", "private, max-age=3600")
      .send(Buffer.from(row.sheet));
  });

  // ---- one state image of a stills pet; 404 when the state has no image (the client falls back to idle) ----
  app.get("/pets/:id/image/:state", async (req, reply) => {
    const userId = authFromRequest(req).userId;
    const { id, state } = req.params as { id: string; state: string };
    const row = db
      .prepare("SELECT data, mime FROM pet_stills WHERE user_id = ? AND pet_id = ? AND state = ?")
      .get(userId, id, state) as { data: Uint8Array; mime: string } | undefined;
    if (!row) throw new AuthError("Pet image not found", 404);
    return reply
      .header("Content-Type", row.mime)
      .header("Cache-Control", "private, max-age=3600")
      .send(Buffer.from(row.data));
  });

  // ---- delete (either kind) ----
  app.delete("/pets/:id", async (req) => {
    const userId = authFromRequest(req).userId;
    const id = (req.params as any).id as string;
    let removed = 0;
    db.exec("BEGIN");
    try {
      removed += Number(db.prepare("DELETE FROM pets WHERE id = ? AND user_id = ?").run(dbId(userId, id), userId).changes);
      removed += deleteStills(userId, id);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    if (removed === 0) throw new AuthError("Pet not found", 404);
    return { ok: true };
  });
}
