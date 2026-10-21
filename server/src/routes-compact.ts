import { isAgentBridgeKind } from "./agent-kinds.js";
import { getUsableProviderRow, modelDenied } from "./shared-providers.js";
import type { FastifyInstance } from "fastify";
import { db, getConversationRow, runEphemeral } from "./db.js";
import { AuthError, authFromRequest } from "./auth.js";
import { isEphemeralId, isLiveEphemeral, getEphemeral, touchEphemeral } from "./ephemeral.js";
import { isGenerating } from "./chat.js";
import { compactConversation } from "./compact.js";
import { assertMaintenanceAllows } from "./maintenance.js";

const bad = (msg: string) => new AuthError(msg, 400);
const MAX_INSTRUCTIONS = 2000;

/** POST /conversations/:id/compact (docs: PROTOCOL-v7 /compact). Summarizes the older turns and stores the summary for later turns. */
export function registerCompactRoutes(app: FastifyInstance): void {
  app.post("/conversations/:id/compact", async (req) => {
    const userId = authFromRequest(req).userId;
    assertMaintenanceAllows(userId);
    const id = String((req.params as any).id ?? "");
    const b: any = req.body && typeof req.body === "object" ? req.body : {};

    let instructions: string | undefined;
    if (b.instructions !== undefined && b.instructions !== null) {
      if (typeof b.instructions !== "string") throw bad("instructions must be a string");
      const t = b.instructions.trim();
      if (t.length > MAX_INSTRUCTIONS) throw bad(`instructions must be at most ${MAX_INSTRUCTIONS} characters`);
      instructions = t || undefined;
    }
    let keepTurns: number | undefined;
    if (b.keepTurns !== undefined && b.keepTurns !== null) {
      if (!Number.isInteger(b.keepTurns) || b.keepTurns < 0 || b.keepTurns > 20) throw bad("keepTurns must be an integer 0..20");
      keepTurns = b.keepTurns;
    }

    const eph = isEphemeralId(id);
    const work = async () => {
      if (eph) {
        // destroyed ephemeral chats have no rows any more: 410 instead of 404
        if (!isLiveEphemeral(userId, id)) {
          if (getEphemeral(id)) throw new AuthError("Conversation not found", 404);
          throw new AuthError("Ephemeral chat no longer exists", 410);
        }
        touchEphemeral(id);
      }
      const conv = getConversationRow(id);
      if (!conv || conv.user_id !== userId || conv.deleted) throw new AuthError("Conversation not found", 404);
      // same provider resolution as measureContext (context.ts)
      const found: any = conv.provider_id
        ? getUsableProviderRow(userId, conv.provider_id)
        : db.prepare("SELECT * FROM providers WHERE user_id = ? AND deleted = 0 ORDER BY created_at, seq LIMIT 1").get(userId);
      const prov = found && !found.deleted ? found : undefined;
      if (prov && modelDenied(userId, prov, conv.model || prov.model || "")) throw new AuthError("This model is not allowed for your account", 403);
      if (conv.mode === "code" || isAgentBridgeKind(prov?.kind)) throw bad("Not available for code chats");
      if (isGenerating(id)) throw new AuthError("A reply is being generated", 409);
      const result = await compactConversation(userId, conv, { instructions, keepTurns });
      if (eph) touchEphemeral(id);
      return { ok: true, ...result };
    };
    return eph ? runEphemeral(work) : work();
  });
}
