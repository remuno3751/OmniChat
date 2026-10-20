/* Attachment HTTP API (docs/design/ATTACHMENTS.md "API"; docs/PROTOCOL-v7-attachments.md).
   Registered as a child plugin, so the raw-bytes parsers below apply to these routes only and other routes keep their bodies. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { authFromRequest } from "./auth.js";
import { readAttachmentSettings } from "./attachments-settings.js";
import { AttachmentTypeError } from "./attachments-types.js";
import {
  attachmentMeta, attachmentsOfUser, deleteAttachment, filePathOf, getAttachmentRow, storeUpload, userUsage,
  type AttachmentRecord,
} from "./attachments.js";

const MB = 1024 * 1024;
/** The parser's own ceiling. The real limit is maxFileMB (checked before the body is read, and again after). */
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "attachment not found", code: "attachment_not_found" });
const gone = (reply: FastifyReply) => reply.code(410).send({ error: "attachment was deleted", code: "attachment_deleted" });

/** RFC 5987 value for Content-Disposition. */
const encodeFileName = (name: string): string =>
  encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The owner's row, or undefined: other users (and shared views) get the same 404 as a missing id. */
function ownedRow(userId: string, id: string): AttachmentRecord | undefined {
  const rec = getAttachmentRow(id);
  return rec && rec.userId === userId ? rec : undefined;
}

export async function registerAttachmentRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    // Drops the inherited parsers (the root's application/json one included) for this scope only, then takes every type as bytes.
    scope.removeAllContentTypeParsers();
    // reads the stream itself so that the limit holds for chunked uploads too (no Content-Length to check up front)
    scope.addContentTypeParser("*", (_req: FastifyRequest, payload: NodeJS.ReadableStream, done: (err: Error | null, body?: Buffer) => void) => {
      const max = readAttachmentSettings().maxFileMB * MB;
      const chunks: Buffer[] = [];
      let size = 0;
      let finished = false;
      const end = (err: Error | null, body?: Buffer) => { if (finished) return; finished = true; done(err, body); };
      payload.on("data", (c: Buffer) => {
        if (finished) return;
        size += c.length;
        if (size > max) {
          chunks.length = 0; // the rest of the upload is read and dropped (not destroyed) so that the client still receives the 413
          end(Object.assign(new Error(`the file is larger than ${Math.round(max / MB)} MB`), { statusCode: 413 }));
          return;
        }
        chunks.push(c);
      });
      payload.on("end", () => end(null, Buffer.concat(chunks)));
      payload.on("error", (e: Error) => end(e));
    });

    scope.post("/attachments", {
      onRequest: async (req, reply) => {
        authFromRequest(req);
        const len = Number(req.headers["content-length"] ?? 0);
        const max = readAttachmentSettings().maxFileMB * MB;
        if (Number.isFinite(len) && len > max) {
          return reply.code(413).send({ error: `the file is larger than ${readAttachmentSettings().maxFileMB} MB`, code: "attachment_too_large" });
        }
      },
    }, async (req, reply) => {
      const userId = authFromRequest(req).userId;
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const header = req.headers["x-file-name"];
      try {
        const { rec, warnings } = await storeUpload(userId, typeof header === "string" ? header : undefined, buf);
        return reply.code(200).send({
          attachment: { ...attachmentMeta(rec), textChars: rec.textChars },
          warnings,
        });
      } catch (e) {
        if (e instanceof AttachmentTypeError) return reply.code(e.status).send({ error: e.message, code: e.code });
        throw e;
      }
    });

    scope.get("/attachments/:id", async (req, reply) => {
      const userId = authFromRequest(req).userId;
      const id = (req.params as { id: string }).id;
      const rec = ownedRow(userId, id);
      if (!rec) return notFound(reply);
      if (rec.status !== "ready") return gone(reply);
      const path = filePathOf(rec);
      if (!existsSync(path)) return reply.code(404).send({ error: "attachment file is missing", code: "attachment_not_found" });
      const bytes = readFileSync(path);
      const image = IMAGE_MIME.has(rec.mime);
      reply.header("Content-Type", rec.mime);
      reply.header("Content-Disposition", `${image ? "inline" : "attachment"}; filename*=UTF-8''${encodeFileName(rec.name)}`);
      // Nothing served from here may run script on this origin, whatever the bytes say.
      reply.header("Content-Security-Policy", "sandbox");
      reply.header("Cache-Control", "private, no-store");
      return reply.send(bytes);
    });

    scope.delete("/attachments/:id", async (req, reply) => {
      const userId = authFromRequest(req).userId;
      const id = (req.params as { id: string }).id;
      const rec = ownedRow(userId, id);
      if (!rec) return notFound(reply);
      if (rec.status !== "ready") return gone(reply);
      deleteAttachment(rec);
      return { ok: true };
    });

    scope.get("/attachments", async (req, reply) => {
      const userId = authFromRequest(req).userId;
      const conv = (req.query as { conversationId?: unknown }).conversationId;
      if (conv !== undefined && (typeof conv !== "string" || conv.length === 0 || conv.length > 64)) {
        return reply.code(400).send({ error: "conversationId must be a string of 1 to 64 characters", code: "attachment_invalid" });
      }
      const rows = attachmentsOfUser(userId, typeof conv === "string" ? conv : null);
      return {
        attachments: rows.map((r) => ({
          ...attachmentMeta(r), textChars: r.textChars, createdAt: r.createdAt, conversationId: r.conversationId, messageId: r.messageId,
        })),
        usage: userUsage(userId),
      };
    });
  });
}

