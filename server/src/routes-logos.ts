import type { FastifyInstance } from "fastify";
import { authFromRequest } from "./auth.js";
import { getModelLogo } from "./model-logos.js";

/** Model logos: GET /model-logo?model=&publisher= (device auth). Bytes of the publisher's avatar, or 404. */
export function registerLogoRoutes(app: FastifyInstance): void {
  app.get("/model-logo", async (req, reply) => {
    authFromRequest(req);
    const q = (req.query ?? {}) as Record<string, unknown>;
    const model = q.model;
    if (typeof model !== "string" || !model.trim() || model.length > 300) return reply.code(400).send({ error: "model is required (max 300 chars)" });
    const publisher = q.publisher;
    if (publisher !== undefined && (typeof publisher !== "string" || publisher.length > 100)) return reply.code(400).send({ error: "publisher must be a string (max 100 chars)" });
    const hit = await getModelLogo(model, typeof publisher === "string" ? publisher : undefined);
    if (!hit) return reply.code(404).send({ error: "not found" });
    reply.header("cache-control", "private, max-age=604800").header("x-content-type-options", "nosniff");
    // SVG can carry script: keep it inert if the image is ever opened directly.
    if (hit.contentType === "image/svg+xml") reply.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return reply.type(hit.contentType).send(hit.bytes);
  });
}
