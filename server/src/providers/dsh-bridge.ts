import { registerProvider, type ChatProvider, type StreamItem, type ProviderConfig, type StreamRequest } from "./index.js";
import { runOnBridge } from "../bridges.js";
import { db, getConversationRow } from "../db.js";
import { registerRun } from "../mirror.js";
import { setConversationCwd } from "../cwd.js";
import { broadcast } from "../hub.js";

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
const asStr = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v) ?? "");

class DshBridgeProvider implements ChatProvider {
  constructor(private readonly cfg: ProviderConfig) {}

  async *stream(req: StreamRequest): AsyncIterable<StreamItem> {
    const ctx = req.context;
    if (!ctx) throw new Error("dsh-bridge requires conversation context");
    const bridgeName = this.cfg.baseUrl.trim();
    if (!bridgeName) throw new Error("dsh-bridge provider needs a bridge name in baseUrl");

    let prompt = "";
    for (let i = req.messages.length - 1; i >= 0; i--) {
      if (req.messages[i].role === "user") { prompt = req.messages[i].content; break; }
    }
    const row = db
      .prepare("SELECT session_id FROM agent_sessions WHERE conversation_id = ? AND provider_id = ?")
      .get(ctx.conversationId, ctx.providerId) as { session_id: string } | undefined;

    const tools = new Map<string, string>();
    let sawText = false;
    let finalText = "";
    const model = typeof req.model === "string" && req.model.includes("::") ? req.model : null;
    const run = registerRun({
      userId: ctx.userId, bridgeName, conversationId: ctx.conversationId,
      sessionId: row?.session_id ?? null,
      userMessageId: ctx.userMessageId ?? null, assistantMessageId: ctx.assistantMessageId ?? null,
    });
    try {
    const convRow = getConversationRow(ctx.conversationId);
    const projectId = (convRow?.project_id as string | null | undefined) ?? null;
    // a new session starts in the folder chosen for the chat (validated when it was sent); unknown = the bridge's default
    const startCwd = !row?.session_id && typeof convRow?.cwd === "string" && convRow.cwd ? convRow.cwd : null;
    for await (const ev of runOnBridge(ctx.userId, bridgeName, {
      sessionId: row?.session_id ?? null, prompt, model, effort: typeof req.effort === "string" ? req.effort : null, cwd: startCwd,
      context: { conversationId: ctx.conversationId, assistantMessageId: ctx.assistantMessageId ?? null, projectId },
    }, req.signal)) {
      switch (ev.type) {
        case "session":
          if (typeof ev.sessionId === "string" && ev.sessionId) {
            db.prepare(
              "INSERT INTO agent_sessions (conversation_id, provider_id, session_id) VALUES (?,?,?) " +
              "ON CONFLICT(conversation_id) DO UPDATE SET provider_id = excluded.provider_id, session_id = excluded.session_id",
            ).run(ctx.conversationId, ctx.providerId, ev.sessionId);
            run.setSession(ev.sessionId);
            if (typeof ev.cwd === "string") {
              const upd = setConversationCwd(ctx.conversationId, ev.cwd);
              if (upd) broadcast(ctx.userId, { type: "upsert", conversations: [upd] });
            }
          }
          break;
        case "status":
          if (ev.phase === "turn_start" && Number.isInteger(ev.turn)) run.linkTurn(ev.turn);
          break;
        case "text":
          if (typeof ev.text === "string" && ev.text) { sawText = true; yield ev.text; }
          break;
        case "thinking":
          if (typeof ev.text === "string" && ev.text) yield { kind: "reasoning", text: ev.text };
          break;
        case "tool_call": {
          const tool = String(ev.tool ?? "tool");
          if (ev.callId != null) tools.set(String(ev.callId), tool);
          yield `\n\n> \u{1F527} ${tool} ${clip(asStr(ev.input ?? {}), 120)}\n\n`;
          break;
        }
        case "tool_result":
          if (ev.status === "error") {
            const tool = tools.get(String(ev.callId)) ?? "tool";
            yield `> ⚠️ ${tool} failed: ${clip(asStr(ev.result ?? ""), 120)}\n\n`;
          }
          break;
        case "final":
          if (typeof ev.text === "string") finalText = ev.text;
          break;
      }
    }
    if (!sawText && finalText) yield finalText;
    } finally {
      run.end();
    }
  }
}

registerProvider("dsh-bridge", (cfg) => new DshBridgeProvider(cfg));
