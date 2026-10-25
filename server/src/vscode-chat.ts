/* Chat from inside VS Code (docs/design/VSCODE-BRIDGE.md S12): the extension sends prompt / models_request /
   conversations_request / conversation_request / set_approval_mode / stop over its /bridge socket and gets prompt_ack, models,
   conversations, transcript and approval_mode frames back. Everything goes through the same paths as the app (a prompt is a normal
   `send`), so the app and other clients see the conversation and its streaming too. Only instances that advertise
   capabilities.chat and capabilities.transcript reach this module (vscode-bridge.ts). */
import { randomUUID } from "node:crypto";
import { db, nextSeq, toConversation, toProvider, getConversationRow, getMessageRow, getProviderRow, parseSearchMode } from "./db.js";
import { broadcast } from "./hub.js";
import { handleSend, isGenerating, stopConversation } from "./chat.js";
import { allModels } from "./models.js";
import { getSettings } from "./projects.js";
import { getUsableProviderRow, modelDenied } from "./shared-providers.js";
import { quotaRefusal } from "./quota.js";
import { isValidCwd, normCwd, setConversationCwd } from "./cwd.js";
import { isAgentBridgeKind } from "./agent-kinds.js";
import { checkRunnable, setVscodeChatHandler, VscodeBridgeError, type RawFrame, type VscodeChatPeer } from "./vscode-bridge.js";
import { activeFeed, historyItems } from "./vscode-transcript.js";
import { getAttachmentRow, deleteAttachment } from "./attachments.js";
import { prepareAttachments } from "./vscode-chat-attach.js";
import { onConversationSettings, onConversationSettingsSet, onHistorySearch } from "./vscode-chat-settings.js";
import { ownConversation, onCompact, onContext, onDevices } from "./vscode-chat-extra.js";
import { onCheckpointFrame } from "./vscode-chat-checkpoints.js";
import { removeLastTurn } from "./vscode-chat-edit.js";

export const VSCODE_PROMPT_MAX_BYTES = 100 * 1024;
const MAX_MODELS = 200;
const MAX_CONVERSATIONS = 30;
const MODES = ["manual", "auto", "full"] as const;
type Mode = (typeof MODES)[number];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const idOf = (v: unknown): string | null => (typeof v === "string" && v.length >= 1 && v.length <= 100 ? v : null);
const isMode = (v: unknown): v is Mode => typeof v === "string" && (MODES as readonly string[]).includes(v);
const VSCODE_PROVIDER_NAME = "VS Code (PC bridge)";
const SEARCH_MODES = ["off", "smart", "always"] as const;
const isSearchMode = (v: unknown): v is (typeof SEARCH_MODES)[number] => typeof v === "string" && (SEARCH_MODES as readonly string[]).includes(v);
const positiveInt = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);

/** Conversations / instances with a prompt in flight (covers the whole turn), against double starts before the run is open. */
const inflightConv = new Set<string>();
const inflightDir = new Set<string>();
const dirKey = (userId: string, bridge: string, cwd: string) => `${userId}\u0000${bridge}\u0000${normCwd(cwd)}`;

function errorFrame(peer: VscodeChatPeer, code: string, message: string, requestId?: string | null): void {
  peer.reply({ type: "error", code, message, ...(requestId ? { requestId } : {}) });
}

/** The user's vscode-bridge provider for this bridge name; created (same shape as the app creates) when missing. */
function ensureProvider(userId: string, bridge: string): any {
  const found = db.prepare("SELECT * FROM providers WHERE user_id = ? AND kind = 'vscode-bridge' AND base_url = ? AND deleted = 0 ORDER BY created_at, seq LIMIT 1").get(userId, bridge);
  if (found) return found;
  const id = randomUUID();
  db.prepare("INSERT INTO providers (id, user_id, name, kind, base_url, model, api_key, created_at, deleted, seq) VALUES (?,?,?,?,?,?,?,?,0,?)")
    .run(id, userId, VSCODE_PROVIDER_NAME, "vscode-bridge", bridge, "vscode", "", Date.now(), nextSeq());
  const row = getProviderRow(id);
  broadcast(userId, { type: "upsert", providers: [toProvider(row)] });
  return row;
}

/** The model used when a prompt names none: the title model, then the search model of the settings, then the last model used here. */
function defaultModelRef(userId: string, bridge: string): string | null {
  try {
    const s = getSettings(userId);
    const ref = s.titleModel || s.search?.searchModel;
    if (typeof ref === "string" && ref.includes("::")) return ref;
  } catch { /* no settings */ }
  const r = db.prepare(
    "SELECT c.model FROM conversations c JOIN providers p ON p.id = c.provider_id WHERE c.user_id = ? AND c.deleted = 0 AND p.kind = 'vscode-bridge' AND p.base_url = ? AND c.model LIKE '%::%' ORDER BY c.updated_at DESC LIMIT 1",
  ).get(userId, bridge) as { model?: string } | undefined;
  return r?.model || null;
}

/** "<providerId>::<modelId>" -> usable for this user, or an ack error code. */
function checkModel(userId: string, ref: string): { ok: true } | { ok: false; error: string; message: string } {
  const i = ref.indexOf("::");
  if (i <= 0 || i + 2 >= ref.length || ref.length > 600) return { ok: false, error: "forbidden_model", message: "model must be '<providerId>::<modelId>'" };
  const row = getUsableProviderRow(userId, ref.slice(0, i));
  if (!row || row.deleted || isAgentBridgeKind(row.kind)) return { ok: false, error: "forbidden_model", message: "The provider of this model is not available" };
  if (modelDenied(userId, row, ref.slice(i + 2))) return { ok: false, error: "forbidden_model", message: "This model is not allowed for your account" };
  const q = quotaRefusal(userId, row);
  if (q) return { ok: false, error: "quota", message: q.message };
  return { ok: true };
}

function upsertConversation(userId: string, id: string): any {
  const conv = toConversation(getConversationRow(id));
  broadcast(userId, { type: "upsert", conversations: [conv] });
  return conv;
}

/* ---------- prompt ---------- */

async function onPrompt(peer: VscodeChatPeer, m: RawFrame): Promise<void> {
  const requestId = idOf(m.requestId);
  if (!requestId) { errorFrame(peer, "invalid_frame", "prompt needs a requestId (1-100 characters)"); return; }
  const ack = (ok: boolean, extra: Record<string, unknown> = {}): void => { peer.reply({ type: "prompt_ack", requestId, ok, ...extra }); };
  const fail = (error: string, message: string): void => ack(false, { error, message });
  const { userId, bridge } = peer;

  const text = typeof m.text === "string" ? m.text : "";
  if (!text.trim()) return fail("invalid_frame", "text is empty");
  if (Buffer.byteLength(text, "utf8") > VSCODE_PROMPT_MAX_BYTES) return fail("invalid_frame", "text is larger than 100 KB");
  if (!isValidCwd(m.cwd)) return fail("invalid_frame", "cwd must be an absolute folder path");
  if (m.conversationId !== undefined && !idOf(m.conversationId)) return fail("invalid_frame", "invalid conversationId");
  if (m.model !== undefined && (typeof m.model !== "string" || m.model.length > 600)) return fail("invalid_frame", "invalid model");
  if (m.approvalMode !== undefined && !isMode(m.approvalMode)) return fail("invalid_frame", "approvalMode must be manual, auto or full");
  if (m.approvalMode === "full" && m.confirmFull !== true) return fail("confirm_required", "approvalMode full needs confirmFull: true");
  if (m.searchMode !== undefined && !isSearchMode(m.searchMode)) { errorFrame(peer, "invalid_frame", "searchMode must be off, smart or always", requestId); return; }
  if (m.interrupt !== undefined && typeof m.interrupt !== "boolean") return fail("invalid_frame", "interrupt must be a boolean");
  if ((m.replaceLast !== undefined && typeof m.replaceLast !== "boolean") || (m.replaceLast === true && typeof m.conversationId !== "string")) return fail("invalid_frame", "replaceLast needs a boolean and a conversationId");

  let row: any = null;
  if (typeof m.conversationId === "string") {
    row = ownConversation(userId, bridge, m.conversationId);
    if (!row) return fail("not_found", "Conversation not found");
  }
  const cwd: string = row?.cwd && isValidCwd(row.cwd) ? row.cwd : m.cwd;
  const modelRef: string | null = (typeof m.model === "string" && m.model) || row?.model || defaultModelRef(userId, bridge);
  if (!modelRef) return fail("no_model", "No model is chosen and no default is configured. Add an OpenAI-compatible provider in the OmniChat app, then pick a model.");
  const mc = checkModel(userId, modelRef);
  if (!mc.ok) return fail(mc.error, mc.message);
  const att = await prepareAttachments(userId, modelRef, m.attachments);
  if (!att.ok) return fail(att.error, att.message);
  const failA = (error: string, message: string): void => { dropAtt(); fail(error, message); };
  const dropAtt = (): void => { for (const id of att.ids) { const r = getAttachmentRow(id); if (r) deleteAttachment(r); } };

  const dk = dirKey(userId, bridge, cwd);
  if (m.interrupt === true && row && (isGenerating(row.id) || inflightConv.has(row.id))) {
    // stop the active run of this conversation, then wait (<= 5 s) until its locks are released
    stopConversation(userId, row.id);
    const t1 = Date.now();
    while ((isGenerating(row.id) || inflightConv.has(row.id) || inflightDir.has(dk)) && Date.now() - t1 < 5_000) await sleep(5);
  }
  if ((row && (isGenerating(row.id) || inflightConv.has(row.id))) || inflightDir.has(dk)) return failA("busy", "A run is already active in this conversation or VS Code window");
  try { checkRunnable(userId, bridge, cwd); } catch (e) {
    if (e instanceof VscodeBridgeError) {
      const code = e.code === "offline" ? "workspace_not_open" : e.code === "protocol" ? "outdated" : e.code;
      return failA(code, e.message);
    }
    return failA("internal", "Cannot start a run");
  }

  if (m.replaceLast === true && row) { const rl = removeLastTurn(userId, row.id); if (!rl.ok) return failA(rl.error, rl.message); }
  // conversation: create or update
  const prov = ensureProvider(userId, bridge);
  let created = false;
  let conversationId: string;
  if (row) {
    conversationId = row.id;
    if (row.model !== modelRef) db.prepare("UPDATE conversations SET model = ?, seq = ? WHERE id = ?").run(modelRef, nextSeq(), row.id);
    if (!row.cwd) setConversationCwd(row.id, cwd);
    if (m.approvalMode !== undefined) db.prepare("UPDATE conversations SET approval_mode = ?, seq = ? WHERE id = ?").run(m.approvalMode === "manual" ? null : m.approvalMode, nextSeq(), row.id);
    if (m.searchMode !== undefined) db.prepare("UPDATE conversations SET search_mode = ?, seq = ? WHERE id = ?").run(m.searchMode, nextSeq(), row.id);
    upsertConversation(userId, row.id);
  } else {
    created = true;
    conversationId = "c" + randomUUID();
    const now = Date.now();
    db.prepare(
      "INSERT INTO conversations (id, user_id, title, provider_id, model, created_at, updated_at, deleted, seq, system_mode, mode, cwd, approval_mode, search_mode) VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,?)",
    ).run(conversationId, userId, "New chat", prov.id, modelRef, now, now, nextSeq(), "append", "code", cwd, m.approvalMode && m.approvalMode !== "manual" ? m.approvalMode : null, isSearchMode(m.searchMode) ? m.searchMode : null);
    upsertConversation(userId, conversationId);
  }

  // exactly what the app's `send` does
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  const st: { err: { code?: string; message: string } | null; finished: boolean } = { err: null, finished: false };
  inflightDir.add(dk);
  inflightConv.add(conversationId);
  const p = handleSend(userId, { conversationId, content: text, userMessageId, assistantMessageId, ...(att.ids.length ? { attachmentIds: att.ids } : {}) }, (f: any) => {
    if (f?.type === "error" && !st.err) st.err = { code: typeof f.code === "string" ? f.code : undefined, message: String(f.message ?? "Rejected") };
  }).catch((e) => { if (!st.err) st.err = { message: e instanceof Error ? e.message : String(e) }; })
    .finally(() => { st.finished = true; inflightDir.delete(dk); inflightConv.delete(conversationId); });
  void p;
  const t0 = Date.now();
  while (!st.err && !getMessageRow(assistantMessageId) && !st.finished && Date.now() - t0 < 10_000) await sleep(5);

  const e = st.err;
  if (e || (st.finished && !getMessageRow(assistantMessageId))) {
    if (created) {
      db.prepare("UPDATE conversations SET deleted = 1, updated_at = ?, seq = ? WHERE id = ?").run(Date.now(), nextSeq(), conversationId);
      upsertConversation(userId, conversationId);
    }
    const c = e?.code ?? "";
    const code = c === "model_not_allowed" ? "forbidden_model" : c.startsWith("quota") ? "quota" : c || "rejected";
    return failA(code, e?.message ?? "The message was not accepted");
  }
  ack(true, { conversationId });
}

/* ---------- other requests ---------- */

async function onModels(peer: VscodeChatPeer, m: RawFrame): Promise<void> {
  const requestId = idOf(m.requestId);
  if (!requestId) { errorFrame(peer, "invalid_frame", "models_request needs a requestId"); return; }
  const items: { ref: string; label: string; provider: string; contextLength?: number; vision?: "yes" | "no" | "unknown" }[] = [];
  try {
    const { groups } = await allModels(peer.userId, false, false);
    for (const g of groups) {
      if (g.kind !== "openai-compatible") continue; // models that can do tool calls; the bridges themselves have none
      for (const mo of g.models) {
        if (items.length >= MAX_MODELS) break;
        // context window as the app's /v1 list reports it (omni-models.ts); image input when the list says
        const cw = positiveInt(mo.state?.contextLength) ?? positiveInt(mo.state?.loadedContextLength);
        items.push({ ref: `${g.providerId}::${mo.id}`, label: mo.name || mo.id, provider: g.providerName, ...(cw ? { contextLength: cw } : {}), ...(mo.vision ? { vision: mo.vision } : {}) });
      }
    }
  } catch { /* an unreachable provider list: answer with what we have */ }
  const def = defaultModelRef(peer.userId, peer.bridge);
  peer.reply({ type: "models", requestId, items, ...(def && items.some((i) => i.ref === def) ? { defaultRef: def } : {}) });
}

const related = (conv: string, want: string): boolean => {
  const a = normCwd(conv), b = normCwd(want);
  return a === b || b.startsWith(a + "/") || a.startsWith(b + "/");
};

function onConversations(peer: VscodeChatPeer, m: RawFrame): void {
  const requestId = idOf(m.requestId);
  if (!requestId) { errorFrame(peer, "invalid_frame", "conversations_request needs a requestId"); return; }
  if (!isValidCwd(m.cwd)) { errorFrame(peer, "invalid_frame", "cwd must be an absolute folder path", requestId); return; }
  const rows = db.prepare(
    "SELECT c.* FROM conversations c JOIN providers p ON p.id = c.provider_id WHERE c.user_id = ? AND c.deleted = 0 AND c.mode = 'code' AND p.kind = 'vscode-bridge' AND p.base_url = ? AND c.cwd IS NOT NULL ORDER BY c.updated_at DESC, c.seq DESC LIMIT 500",
  ).all(peer.userId, peer.bridge) as any[];
  const items = rows.filter((r) => typeof r.cwd === "string" && related(r.cwd, m.cwd)).slice(0, MAX_CONVERSATIONS).map((r) => {
    const c = toConversation(r);
    return { id: c.id, title: c.title, updatedAt: c.updatedAt, approvalMode: c.approvalMode, searchMode: parseSearchMode(c.searchMode) ?? "smart", cwd: c.cwd };
  });
  peer.reply({ type: "conversations", requestId, items });
}

function onConversation(peer: VscodeChatPeer, m: RawFrame): void {
  const requestId = idOf(m.requestId);
  const id = idOf(m.conversationId);
  if (!requestId || !id) { errorFrame(peer, "invalid_frame", "conversation_request needs requestId and conversationId", requestId); return; }
  if (!ownConversation(peer.userId, peer.bridge, id)) { errorFrame(peer, "not_found", "Conversation not found", requestId); return; }
  const runId = activeFeed(id)?.runId;
  peer.reply({ type: "transcript", requestId, conversationId: id, ...(runId ? { runId } : {}), reset: true, items: historyItems(id) });
}

function onSetMode(peer: VscodeChatPeer, m: RawFrame): void {
  const requestId = idOf(m.requestId);
  const id = idOf(m.conversationId);
  if (!requestId || !id) { errorFrame(peer, "invalid_frame", "set_approval_mode needs requestId and conversationId", requestId); return; }
  const reply = (ok: boolean, mode: unknown, error?: string) => peer.reply({ type: "approval_mode", requestId, conversationId: id, ...(isMode(mode) ? { mode } : {}), ok, ...(error ? { error } : {}) });
  if (!isMode(m.mode)) { reply(false, undefined, "invalid_frame"); return; }
  if (m.mode === "full" && m.confirmFull !== true) { reply(false, m.mode, "confirm_required"); return; }
  if (!ownConversation(peer.userId, peer.bridge, id)) { reply(false, m.mode, "not_found"); return; }
  db.prepare("UPDATE conversations SET approval_mode = ?, seq = ? WHERE id = ?").run(m.mode === "manual" ? null : m.mode, nextSeq(), id);
  upsertConversation(peer.userId, id);
  reply(true, m.mode);
}

function onStop(peer: VscodeChatPeer, m: RawFrame): void {
  const requestId = idOf(m.requestId);
  const id = idOf(m.conversationId);
  if (!id) { errorFrame(peer, "invalid_frame", "stop needs a conversationId", requestId); return; }
  if (!ownConversation(peer.userId, peer.bridge, id)) { errorFrame(peer, "not_found", "Conversation not found", requestId); return; }
  stopConversation(peer.userId, id);
}

export function handleVscodeChatFrame(peer: VscodeChatPeer, m: RawFrame): void {
  const fatal = (e: unknown) => { console.error("vscode chat frame failed", e); errorFrame(peer, "internal", "Chat request failed", idOf(m.requestId)); };
  try {
    switch (m.type) {
      case "prompt": onPrompt(peer, m).catch(fatal); return;
      case "models_request": onModels(peer, m).catch(fatal); return;
      case "conversations_request": onConversations(peer, m); return;
      case "conversation_request": onConversation(peer, m); return;
      case "set_approval_mode": onSetMode(peer, m); return;
      case "stop": onStop(peer, m); return;
      case "context_request": onContext(peer, m).catch(fatal); return;
      case "devices_request": onDevices(peer, m); return;
      case "compact_request": onCompact(peer, m).catch(fatal); return;
      case "conversation_settings_request": onConversationSettings(peer, m); return;
      case "conversation_settings_set": onConversationSettingsSet(peer, m); return;
      case "history_search_request": onHistorySearch(peer, m); return;
      case "checkpoints_request": case "checkpoint_restore": onCheckpointFrame(peer, m); return;
    }
  } catch (e) { fatal(e); }
}

setVscodeChatHandler(handleVscodeChatFrame);
