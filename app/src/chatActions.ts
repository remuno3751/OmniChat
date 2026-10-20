import { api, uuid } from './api';
import { isEphemeralId, newEphemeralId } from './ephemeral';
import type { Conversation, Effort, Message, ResponseFormat } from './protocol';
import { wsSend } from './socket';
import { addLocalMessage, applyUpsert, discardLocalMessage, failPending, getState, patchConversationLocal } from './store';
import { deepestLeaf } from './tree';
import type { Tree } from './tree';
import { toast } from './ui/toast';
import { t } from './i18n';
import { getDevice, setDevice } from './deviceSettings';
import { restoreDraft } from './contextState';
import { decideConflict, isRememberable, parseConflict } from './modelLoad';
import type { Choice, Decision, LoadPolicy } from './modelLoad';
import { getPrompt, setPrompt, setProgress } from './modelLoadState';

/** Message id for a chat: ephemeral chats need the eph_ prefix on every message id (PROTOCOL-v7). */
const msgIdFor = (convId: string): string => (isEphemeralId(convId) ? newEphemeralId(uuid) : uuid());

interface SendOpts {
  convId: string; content: string; parentId?: string | null; lastVisibleId?: string | null;
  effort?: Effort | null; responseFormat?: ResponseFormat | null;
  loadPolicy?: LoadPolicy; useModel?: string;
  /** Code: working folder of the first message of a new chat (the bridge's known workspaces) */
  cwd?: string;
}
interface RegenOpts {
  convId: string; messageId: string; parentId: string | null;
  effort?: Effort | null; responseFormat?: ResponseFormat | null;
  loadPolicy?: LoadPolicy; useModel?: string;
}
/**
 * The last request that may need a retry after a model conflict. `sentPolicy` is the policy actually attached
 * (explicit or remembered): a conflict despite a policy shows the dialog instead of an automatic retry (no loops).
 */
type Retained =
  | { kind: 'send'; opts: SendOpts; assistantMessageId: string; sentPolicy?: LoadPolicy }
  | { kind: 'regenerate'; opts: RegenOpts; assistantMessageId: string; prevHead: string | null; sentPolicy?: LoadPolicy };
let lastReq: Retained | null = null;

/**
 * The policy to attach: an explicit one, else the remembered device setting (not 'ask').
 * useModel only goes with use_loaded; without it the server uses the first loaded model.
 */
function resolvePolicy(o: { loadPolicy?: LoadPolicy; useModel?: string }): { loadPolicy?: LoadPolicy; useModel?: string } {
  const remembered = getDevice().modelLoadPolicy;
  const loadPolicy = o.loadPolicy ?? (remembered !== 'ask' ? remembered : undefined);
  if (!loadPolicy) return {};
  const useModel = loadPolicy === 'use_loaded' && o.useModel ? o.useModel : undefined;
  return useModel ? { loadPolicy, useModel } : { loadPolicy };
}

function issueSend(o: SendOpts): string {
  const { convId, content } = o;
  const v3 = getState().v3;
  const userMessageId = msgIdFor(convId);
  const assistantMessageId = msgIdFor(convId);
  const policy = resolvePolicy(o);
  const msg: any = { type: 'send', conversationId: convId, content, userMessageId, assistantMessageId };
  if (v3 && o.parentId !== undefined) msg.parentId = o.parentId;
  if (o.effort) msg.effort = o.effort;
  if (o.responseFormat) msg.responseFormat = o.responseFormat;
  if (o.cwd) msg.cwd = o.cwd;
  if (policy.loadPolicy) msg.loadPolicy = policy.loadPolicy;
  if (policy.useModel) msg.useModel = policy.useModel;
  if (!wsSend(msg)) return t('act.notConnectedRetry');
  const optParent = o.parentId !== undefined ? o.parentId : o.lastVisibleId ?? null;
  const local: Message = { id: userMessageId, conversationId: convId, role: 'user', content, status: 'done', createdAt: Date.now(), seq: 0 };
  if (v3) local.parentId = optParent;
  lastSend = { convId, userMessageId, content, prevHead: getState().conversations[convId]?.headId ?? null };
  lastReq = { kind: 'send', opts: { ...o }, assistantMessageId, sentPolicy: policy.loadPolicy };
  addLocalMessage(local);
  if (v3) patchConversationLocal(convId, { headId: userMessageId });
  return '';
}

/**
 * Send a user message. `parentId` undefined = continue the current branch (server default = headId);
 * a string/null = explicit parent (edit & resend uses the edited message's parentId).
 * Returns an error string, or '' on success.
 */
export function sendUser(o: SendOpts): string {
  return issueSend(o);
}

let lastSend: { convId: string; userMessageId: string; content: string; prevHead: string | null } | null = null;
/**
 * The server refused the last send (e.g. context_overflow) and never stored it: remove the optimistic row,
 * restore the head and hand back { convId, content } so the composer can show the text again.
 */
export function rollbackLastSend(): { convId: string; content: string } | null {
  const s = lastSend;
  lastSend = null;
  if (!s || !discardLocalMessage(s.convId, s.userMessageId)) return null;
  if (getState().v3) patchConversationLocal(s.convId, { headId: s.prevHead });
  return { convId: s.convId, content: s.content };
}

function issueRegenerate(o: RegenOpts): string {
  const assistantMessageId = msgIdFor(o.convId);
  const policy = resolvePolicy(o);
  const msg: any = { type: 'regenerate', conversationId: o.convId, messageId: o.messageId, assistantMessageId };
  if (o.effort) msg.effort = o.effort;
  if (o.responseFormat) msg.responseFormat = o.responseFormat;
  if (policy.loadPolicy) msg.loadPolicy = policy.loadPolicy;
  if (policy.useModel) msg.useModel = policy.useModel;
  if (!wsSend(msg)) return t('act.notConnectedRetry');
  const prevHead = getState().conversations[o.convId]?.headId ?? null;
  lastReq = { kind: 'regenerate', opts: { ...o }, assistantMessageId, prevHead, sentPolicy: policy.loadPolicy };
  addLocalMessage({
    id: assistantMessageId, conversationId: o.convId, role: 'assistant', content: '', status: 'streaming',
    createdAt: Date.now(), seq: 0, parentId: o.parentId,
  });
  patchConversationLocal(o.convId, { headId: assistantMessageId });
  return '';
}

/** Redo an assistant message as a new sibling. */
export function regenerate(o: { convId: string; message: Message; tree: Tree; effort?: Effort | null; responseFormat?: ResponseFormat | null; loadPolicy?: LoadPolicy; useModel?: string }): string {
  return issueRegenerate({
    convId: o.convId, messageId: o.message.id, parentId: o.tree.parent.get(o.message.id) ?? null,
    effort: o.effort, responseFormat: o.responseFormat, loadPolicy: o.loadPolicy, useModel: o.useModel,
  });
}

/** Re-issue a retained request with a policy. Returns an error string, or '' on success. */
function reissue(req: Retained, loadPolicy: LoadPolicy, useModel?: string): string {
  if (req.kind === 'send') return issueSend({ ...req.opts, loadPolicy, useModel });
  return issueRegenerate({ ...req.opts, loadPolicy, useModel });
}

/** Undo the optimistic rows of the retained request (the server never stored the turn). */
function rollbackRetained(req: Retained | null): void {
  if (!req) return;
  if (req.kind === 'send') { rollbackLastSend(); return; }
  discardLocalMessage(req.opts.convId, req.assistantMessageId);
  if (getState().v3) patchConversationLocal(req.opts.convId, { headId: req.prevHead });
}

/**
 * Called by socket.ts for error frames with code 'model_conflict' or 'model_load_failed'.
 * Rolls back the optimistic rows, then either re-sends with the remembered policy or opens the dialog.
 */
export function handleModelConflict(m: any): void {
  const conflict = parseConflict(m);
  if (!conflict) {
    // not a usable conflict frame: the generic failure handling
    toast(m?.message || t('socket.serverError'), 'error');
    failPending(m?.messageId);
    setProgress(null);
    return;
  }
  const req = lastReq;
  const sameTurn = !!req
    && (!m.conversationId || m.conversationId === req.opts.convId)
    && (!m.messageId || m.messageId === req.assistantMessageId);
  if (!req || !sameTurn) {
    // a conflict for a turn this device is not waiting on: nothing to retry, just tell the user
    toast(m.message || t('socket.serverError'), 'error');
    setProgress(null);
    return;
  }
  setProgress(null);
  rollbackRetained(req);
  const failed = m.code === 'model_load_failed';
  // a conflict despite an attached policy must not loop: ask
  const d: Decision = req.sentPolicy ? { action: 'ask' } : decideConflict(getDevice().modelLoadPolicy, conflict, failed);
  if (d.action === 'send') {
    const err = reissue(req, d.policy, d.useModel);
    if (err) {
      toast(err, 'error');
      if (req.kind === 'send') restoreDraft(req.opts.convId, req.opts.content);
    }
    return;
  }
  setPrompt({
    kind: req.kind,
    conversationId: req.opts.convId,
    conflict,
    error: failed ? (m.message || t('socket.serverError')) : undefined,
  });
}

/**
 * The user answered the conflict dialog. Cancel restores the draft and persists nothing; any other choice
 * re-sends the retained request with that policy (and remembers it when asked, not for cancel).
 */
export function resolveConflictPrompt(choice: Choice, opts: { remember?: boolean; useModel?: string } = {}): void {
  const p = getPrompt();
  const req = lastReq;
  setPrompt(null);
  if (choice === 'cancel') {
    if (req?.kind === 'send') restoreDraft(req.opts.convId, req.opts.content);
    lastReq = null;
    return;
  }
  if (!p || !req) return;
  if (opts.remember && isRememberable(choice)) setDevice({ modelLoadPolicy: choice });
  const useModel = choice === 'use_loaded' ? (opts.useModel ?? p.conflict.loaded[0]?.id) : undefined;
  const err = reissue(req, choice, useModel);
  if (err) {
    toast(err, 'error');
    if (req.kind === 'send') restoreDraft(req.opts.convId, req.opts.content);
  }
}

/** Pinned = `pinned: true`; a server without the field counts as not pinned. */
export const isPinned = (c: Conversation | null | undefined): boolean => c?.pinned === true;

/** Pin or unpin a chat. Throws on failure; the caller shows the message. */
export async function setPinned(convId: string, pinned: boolean): Promise<void> {
  applyUpsert({ conversations: [await api.putConversation(convId, { pinned })] as Conversation[] });
}

/** Show another sibling's branch: head = deepest latest leaf of that sibling's subtree. */
export async function switchBranch(convId: string, tree: Tree, siblingId: string): Promise<void> {
  const conv = getState().conversations[convId];
  const prev = conv?.headId ?? null;
  const head = deepestLeaf(tree, siblingId);
  patchConversationLocal(convId, { headId: head });
  try {
    applyUpsert({ conversations: [await api.putConversation(convId, { headId: head })] as Conversation[] });
  } catch (e: any) {
    patchConversationLocal(convId, { headId: prev });
    toast(e?.message || t('act.switchBranchFailed'), 'error');
  }
}
