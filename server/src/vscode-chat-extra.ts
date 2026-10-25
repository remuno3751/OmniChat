/* Chat from inside VS Code, two more requests (docs/design/V055-CONTRACT.md "v0.5.5-beta.2 additions"): devices_request (the bridges
   of this user that are online now) and compact_request (the same summary as the app's /compact). Dispatched from vscode-chat.ts. */
import { db, getConversationRow, getProviderRow } from "./db.js";
import { isGenerating } from "./chat.js";
import { compactConversation } from "./compact.js";
import { measureContext } from "./context.js";
import { listBridges } from "./bridges.js";
import { AuthError } from "./auth.js";
import { listVscodeBridges, type RawFrame, type VscodeChatPeer } from "./vscode-bridge.js";
import { normCwd } from "./cwd.js";
import { getUsableProviderRow } from "./shared-providers.js";

const MAX_DEVICES = 50;
const MAX_WORKSPACES = 50;

const idOf = (v: unknown): string | null => (typeof v === "string" && v.length >= 1 && v.length <= 100 ? v : null);
const errorFrame = (peer: VscodeChatPeer, code: string, message: string, requestId?: string | null): void => {
  peer.reply({ type: "error", code, message, ...(requestId ? { requestId } : {}) });
};

/** The conversation when it is a live Code conversation of this user on a vscode-bridge provider named `bridge`. */
export function ownConversation(userId: string, bridge: string, id: string): any | null {
  const row = getConversationRow(id);
  if (!row || row.user_id !== userId || row.deleted || row.mode !== "code" || !row.provider_id) return null;
  const prov = getProviderRow(row.provider_id);
  return prov && prov.user_id === userId && prov.kind === "vscode-bridge" && String(prov.base_url ?? "").trim() === bridge ? row : null;
}

/** devices_request -> devices: the user's online vscode and dsh bridges; `self` is the asking extension's bridge. */
export function onDevices(peer: VscodeChatPeer, m: RawFrame): void {
  const requestId = idOf(m.requestId);
  if (!requestId) { errorFrame(peer, "invalid_frame", "devices_request needs a requestId"); return; }
  const workspaces = (b: { cwd: string; workspaces: string[] }): string[] => {
    const seen = new Map<string, string>();
    for (const w of [b.cwd, ...b.workspaces]) if (w && !seen.has(normCwd(w))) seen.set(normCwd(w), w);
    return [...seen.values()].slice(0, MAX_WORKSPACES);
  };
  const vscode = listVscodeBridges(peer.userId).map((b) => ({ name: b.name, kind: "vscode" as const, online: true, self: b.name === peer.bridge, workspaces: workspaces(b) }));
  const dsh = listBridges(peer.userId)
    .filter((b) => !("kind" in b))
    .map((b) => ({ name: b.name, kind: "dsh" as const, online: true, self: b.name === peer.bridge, workspaces: workspaces(b) }));
  peer.reply({ type: "devices", requestId, items: [...vscode, ...dsh].slice(0, MAX_DEVICES) });
}

/** compact_request -> compacted (tokens before/after) or an error frame; refused while a run of the conversation is active. */
export async function onCompact(peer: VscodeChatPeer, m: RawFrame): Promise<void> {
  const requestId = idOf(m.requestId);
  const id = idOf(m.conversationId);
  if (!requestId || !id) { errorFrame(peer, "invalid_frame", "compact_request needs requestId and conversationId", requestId); return; }
  const row = ownConversation(peer.userId, peer.bridge, id);
  if (!row) { errorFrame(peer, "not_found", "Conversation not found", requestId); return; }
  if (isGenerating(id)) { errorFrame(peer, "busy", "A run is active in this conversation", requestId); return; }
  try {
    // the summary runs on the conversation's real model ("<providerId>::<model>"); its own provider is the VS Code bridge
    const ref = String(row.model ?? "");
    const i = ref.indexOf("::");
    const real = i > 0 ? getUsableProviderRow(peer.userId, ref.slice(0, i)) : null;
    const conv = real && !real.deleted ? { ...row, provider_id: real.id, model: ref.slice(i + 2) } : row;
    const r = await compactConversation(peer.userId, conv, {});
    if (!r.compacted) { peer.reply({ type: "error", code: String(r.reason || "too_short"), message: "Nothing to compact", requestId }); return; }
    peer.reply({ type: "compacted", requestId, conversationId: id, ok: true, before: r.tokensBefore, after: r.tokensAfter });
  } catch (e) {
    console.error("vscode compact failed", e);
    errorFrame(peer, "internal", e instanceof AuthError ? e.message : "Compact failed", requestId);
  }
}

/* context_request -> context: the same measure as the app; `last` = the latest finished reply's tokens (metrics). */
export async function onContext(peer: VscodeChatPeer, m: RawFrame): Promise<void> {
  const requestId = idOf(m.requestId);
  const id = idOf(m.conversationId);
  if (!requestId || !id) { errorFrame(peer, "invalid_frame", "context_request needs requestId and conversationId", requestId); return; }
  const row = ownConversation(peer.userId, peer.bridge, id);
  if (!row) { errorFrame(peer, "not_found", "Conversation not found", requestId); return; }
  try {
    const { usage } = await measureContext({ userId: peer.userId, conv: row });
    // tokens of the latest finished assistant reply (its usage lives in metrics, keyed by message id)
    const lm = db.prepare(
      "SELECT m.prompt_tokens AS p, m.completion_tokens AS c, m.reasoning_tokens AS r FROM messages msg JOIN metrics m ON m.message_id = msg.id " +
      "WHERE msg.conversation_id = ? AND msg.role = 'assistant' AND msg.status = 'done' ORDER BY msg.seq DESC LIMIT 1",
    ).get(id) as { p: number; c: number; r: number } | undefined;
    const last = lm && (lm.p || lm.c || lm.r) ? { prompt: lm.p ?? 0, completion: lm.c ?? 0, reasoning: lm.r ?? 0 } : undefined;
    peer.reply({
      type: "context", requestId, total: usage.total, limit: usage.limit ?? 0, fits: usage.fits, estimated: usage.estimated,
      used: usage.used, reasoning: usage.reasoning, ...(last ? { last } : {}),
    });
  } catch (e) {
    console.error("vscode context failed", e);
    errorFrame(peer, "internal", "Context measurement failed", requestId);
  }
}
