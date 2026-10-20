import type { FastifyInstance } from "fastify";
import { db } from "./db.js";
import { AuthError, authFromRequest } from "./auth.js";

// Pets (PROTOCOL-v4.md section 9): per-user imported Codex pets stored in the `pets` table.

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

interface PetItem {
  id: string;
  name: string;
  description: string;
  spriteVersionNumber: 1 | 2;
  mime: string;
  size: number;
  createdAt: number;
}

export function registerPetRoutes(app: FastifyInstance): void {
  // ---- import / replace a pet ----
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
    if (!owner) {
      const n = db.prepare("SELECT COUNT(*) AS n FROM pets WHERE user_id = ?").get(userId) as { n: number };
      if (Number(n.n) >= MAX_PETS) throw bad(`at most ${MAX_PETS} pets per user`);
    }

    const now = Date.now();
    db.prepare(
      `INSERT INTO pets (id, user_id, name, manifest, sheet, mime, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, manifest = excluded.manifest, sheet = excluded.sheet,
         mime = excluded.mime, created_at = excluded.created_at`,
    ).run(key, userId, manifest.displayName, JSON.stringify(manifest), sheet, mime, now);

    const item: PetItem = {
      id: manifest.id,
      name: manifest.displayName,
      description: manifest.description,
      spriteVersionNumber: manifest.spriteVersionNumber,
      mime,
      size: sheet.length,
      createdAt: now,
    };
    return item;
  });

  // ---- list (no blobs) ----
  app.get("/pets", async (req) => {
    const userId = authFromRequest(req).userId;
    const rows = db
      .prepare("SELECT id, name, manifest, mime, length(sheet) AS size, created_at FROM pets WHERE user_id = ? ORDER BY created_at, id")
      .all(userId) as any[];
    const pets: PetItem[] = rows.map((r) => {
      const m = JSON.parse(String(r.manifest));
      return {
        id: String(r.id).slice(userId.length + 1),
        name: String(r.name),
        description: typeof m.description === "string" ? m.description : "",
        spriteVersionNumber: m.spriteVersionNumber === 2 ? 2 : 1,
        mime: String(r.mime),
        size: Number(r.size),
        createdAt: Number(r.created_at),
      };
    });
    return { pets };
  });

  // ---- sprite sheet binary ----
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

  // ---- delete ----
  app.delete("/pets/:id", async (req) => {
    const userId = authFromRequest(req).userId;
    const id = (req.params as any).id as string;
    const res = db.prepare("DELETE FROM pets WHERE id = ? AND user_id = ?").run(dbId(userId, id), userId);
    if (Number(res.changes) === 0) throw new AuthError("Pet not found", 404);
    return { ok: true };
  });
}
