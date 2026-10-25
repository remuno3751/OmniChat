import type { FastifyInstance } from "fastify";
import { db, toConversation, toMessage, toProvider } from "./db.js";
import { toProject, toPreset, getSettings } from "./projects.js";
import { toFolder } from "./folders.js";
import { authFromRequest } from "./auth.js";
import { listSharedProvidersFor } from "./shared-providers.js";
import { readGeneral } from "./server-general.js";
import { listTemplatesSince } from "./templates.js";

/** GET /sync?since=N — everything changed after seq N (settings only if changed). */
export function registerSync(app: FastifyInstance): void {
  app.get("/sync", async (req) => {
    const userId = authFromRequest(req).userId;
    const since = Number((req.query as any).since ?? 0) || 0;
    const q = (table: string) => db.prepare(`SELECT * FROM ${table} WHERE user_id = ? AND seq > ? ORDER BY seq`).all(userId, since) as any[];
    const conversations = q("conversations").map(toConversation);
    const messages = q("messages").map(toMessage);
    // own providers by seq; shared providers this user may use are sent in full on every sync (read-only, no URL or key)
    const providers: any[] = [...q("providers").map(toProvider), ...listSharedProvidersFor(userId)];
    const projects = q("projects").map(toProject);
    const presets = q("prompt_presets").map(toPreset);
    const folders = q("chat_folders").map(toFolder);
    const st = getSettings(userId);
    const settings = st.seq > since || since === 0 ? st : undefined; // a full sync always carries the settings, even before the user saved any (the app hides context settings without them)
    const templates = listTemplatesSince(userId, since);
    let seq = since;
    for (const r of [...conversations, ...messages, ...providers, ...projects, ...presets, ...folders, ...templates, ...(settings ? [settings] : [])]) {
      if (r.seq > seq) seq = r.seq;
    }
    return { seq, conversations, messages, providers, projects, presets, folders, templates, ...(settings ? { settings } : {}), allowOwnProviders: readGeneral().allowOwnProviders };
  });
}
