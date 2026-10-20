import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Conversation, Maintenance, Message, PhaseName, Project, ToolCall, PromptPreset, Provider, Settings, SyncResponse, Template, UpsertPayload } from './protocol';
import { dropEphemeralFrom, ephemeralConvIds, isEphemeralId, isEphemeralRow, stripEphemeral } from './ephemeral';

export interface State {
  ready: boolean;
  user: { userId: string; username: string } | null;
  conversations: Record<string, Conversation>;
  messages: Record<string, Record<string, Message>>; // convId -> id -> message
  providers: Record<string, Provider>;
  projects: Record<string, Project>;
  presets: Record<string, PromptPreset>;
  /** v4: prompt/action templates (soft-deleted rows are kept; use activeTemplates). */
  templates: Record<string, Template>;
  settings: Settings | null;
  /** true once the server is known to speak protocol v3 (hides v3 features on an old server). */
  v3: boolean;
  /** project ids collapsed in the sidebar ('' = Unclassified). */
  collapsed: Record<string, boolean>;
  /** message shown on the login screen (e.g. device revoked). */
  notice: string;
  lastSeq: number;
  connected: boolean;
  lastSel: ModelSel | null;
  /** v7: the server answered GET /version with ephemeral support. Not persisted; UI: useStore(s => s.ephemeralSupported). */
  ephemeralSupported: boolean;
  /** maintenance mode (null = unknown or an old server). Not persisted; see setMaintenance. */
  maintenance: Maintenance | null;
  /** PROTOCOL-v7: may ordinary users add their own providers (undefined = unknown, an old server). Not persisted. */
  allowOwnProviders?: boolean;
}

export interface ModelSel { providerId: string; model: string | null }

const empty = (): State => ({
  ready: false, user: null, conversations: {}, messages: {}, providers: {}, projects: {}, presets: {}, templates: {}, settings: null,
  v3: false, collapsed: {}, notice: '', lastSeq: 0, connected: false, lastSel: null, ephemeralSupported: false, maintenance: null, allowOwnProviders: undefined,
});

let state: State = empty();
const listeners = new Set<() => void>();
let persistTimer: any = null;

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
  schedulePersist();
}
export const getState = () => state;
export function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

const cacheKey = (userId: string) => `omnichat.cache.${userId}`;
const collapsedKey = (userId: string) => `omnichat.collapsed.${userId}`;

function schedulePersist() {
  if (!state.user || !state.ready) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (!state.user) return;
    const { providers, projects, presets, templates, settings, v3, lastSeq } = state;
    // v7: ephemeral chats never reach the offline cache
    const { conversations, messages } = stripEphemeral({ conversations: state.conversations, messages: state.messages });
    AsyncStorage.setItem(cacheKey(state.user.userId), JSON.stringify({ conversations, messages, providers, projects, presets, templates, settings, v3, lastSeq })).catch(() => {});
  }, 500);
}

export async function loadCache(user: { userId: string; username: string }) {
  let cached: any = null;
  let collapsed: Record<string, boolean> = {};
  try {
    const raw = await AsyncStorage.getItem(cacheKey(user.userId));
    if (raw) cached = JSON.parse(raw);
    const c = await AsyncStorage.getItem(collapsedKey(user.userId));
    if (c) collapsed = JSON.parse(c) || {};
  } catch {}
  // v7: drop ephemeral rows from a cache written by anything else
  const cachedRows = stripEphemeral({ conversations: cached?.conversations || {}, messages: cached?.messages || {} });
  state = {
    ...empty(),
    ready: true,
    user,
    conversations: cachedRows.conversations,
    messages: cachedRows.messages,
    providers: cached?.providers || {},
    projects: cached?.projects || {},
    presets: cached?.presets || {},
    templates: cached?.templates || {},
    settings: cached?.settings || null,
    v3: !!cached?.v3,
    collapsed,
    lastSeq: cached?.lastSeq || 0,
    lastSel: await loadLastSel(user.userId),
  };
  listeners.forEach((l) => l());
}

const selKey = (userId: string) => `omnichat.lastModel.${userId}`;
async function loadLastSel(userId: string): Promise<ModelSel | null> {
  try {
    const raw = await AsyncStorage.getItem(selKey(userId));
    const v = raw ? JSON.parse(raw) : null;
    if (v && typeof v.providerId === 'string') return { providerId: v.providerId, model: v.model ?? null };
  } catch {}
  return null;
}
export function setLastSel(sel: ModelSel) {
  set({ lastSel: sel });
  const u = state.user;
  if (u) AsyncStorage.setItem(selKey(u.userId), JSON.stringify(sel)).catch(() => {});
}

export function toggleCollapsed(projectId: string) {
  const collapsed = { ...state.collapsed, [projectId]: !state.collapsed[projectId] };
  set({ collapsed });
  const u = state.user;
  if (u) AsyncStorage.setItem(collapsedKey(u.userId), JSON.stringify(collapsed)).catch(() => {});
}

export async function clearAll() {
  const u = state.user;
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  state = { ...empty(), ready: true };
  listeners.forEach((l) => l());
  if (u) { try { await AsyncStorage.removeItem(cacheKey(u.userId)); } catch {} }
}
export function setNotice(notice: string) { set({ notice }); }
export function setV3(v3: boolean) { if (state.v3 !== v3) set({ v3 }); }

export function markReady() {
  if (!state.ready) set({ ready: true });
}

/** v7: whether the server supports ephemeral chats (from GET /version). Not persisted. */
export function setEphemeralSupported(ephemeralSupported: boolean) {
  if (state.ephemeralSupported !== ephemeralSupported) set({ ephemeralSupported });
}

export function setConnected(connected: boolean) {
  if (state.connected !== connected) set({ connected });
}

/** Maintenance mode as the server last said it (hello / maintenance frame / PUT). Not persisted. */
export function setMaintenance(maintenance: Maintenance | null) {
  if (JSON.stringify(state.maintenance) !== JSON.stringify(maintenance)) set({ maintenance });
}

/** PROTOCOL-v7: the server's answer about ordinary users adding their own providers (undefined = not sent). */
export function setAllowOwnProviders(allowOwnProviders: boolean | undefined) {
  if (state.allowOwnProviders !== allowOwnProviders) set({ allowOwnProviders });
}

/**
 * Replaces every shared provider (readOnly) in the list with the given ones, so a removed share disappears.
 * The owner's own providers are not touched.
 */
export function setSharedProviders(shared: Provider[]) {
  const providers = { ...state.providers };
  for (const id of Object.keys(providers)) if (providers[id].readOnly) delete providers[id];
  for (const p of shared) if (p.readOnly) providers[p.id] = { ...p, deleted: false };
  set({ providers });
}

/** A send was refused with code 'maintenance': the banner must show it, whatever the last known state was. */
export function noteMaintenanceBlocked(message: string) {
  if (state.maintenance?.enabled) return;
  setMaintenance({ enabled: true, message: message || '', eta: null, updatedAt: Date.now() });
}

export function applyUpsert(u: UpsertPayload, seq?: number) {
  let { conversations, messages, providers, projects, presets, templates, settings, v3 } = state;
  let maxSeq = Math.max(state.lastSeq, seq || 0);
  if (u.conversations?.length) {
    conversations = { ...conversations };
    for (const c of u.conversations) {
      const old = conversations[c.id];
      if (!old || c.seq >= old.seq) conversations[c.id] = c;
      // ephemeral rows are not in /sync: their seq must not move the sync cursor
      if (!isEphemeralRow(c)) maxSeq = Math.max(maxSeq, c.seq);
    }
  }
  if (u.providers?.length) {
    providers = { ...providers };
    for (const p of u.providers) {
      const old = providers[p.id];
      // a shared provider (readOnly) has no seq: it always replaces the old copy
      if (!old || (p.seq ?? 0) >= (old.seq ?? 0)) providers[p.id] = p;
      if (typeof p.seq === 'number') maxSeq = Math.max(maxSeq, p.seq);
    }
  }
  if (u.projects !== undefined) {
    v3 = true;
    if (u.projects.length) {
      projects = { ...projects };
      for (const p of u.projects) {
        const old = projects[p.id];
        if (!old || p.seq >= old.seq) projects[p.id] = p;
        maxSeq = Math.max(maxSeq, p.seq);
      }
    }
  }
  if (u.presets !== undefined) {
    v3 = true;
    if (u.presets.length) {
      presets = { ...presets };
      for (const p of u.presets) {
        const old = presets[p.id];
        if (!old || p.seq >= old.seq) presets[p.id] = p;
        maxSeq = Math.max(maxSeq, p.seq);
      }
    }
  }
  if (u.templates !== undefined) {
    v3 = true;
    if (u.templates.length) {
      templates = { ...templates };
      for (const t of u.templates) {
        const old = templates[t.id];
        if (!old || t.seq >= old.seq) templates[t.id] = t;
        maxSeq = Math.max(maxSeq, t.seq);
      }
    }
  }
  if (u.settings) {
    v3 = true;
    if (!settings || u.settings.seq >= settings.seq) settings = { ...u.settings, devMode: !!u.settings.devMode };
    maxSeq = Math.max(maxSeq, u.settings.seq || 0);
  }
  if (u.messages?.length) {
    messages = { ...messages };
    for (const m of u.messages) {
      const bucket = { ...(messages[m.conversationId] || {}) };
      const old = bucket[m.id];
      if (!old || m.seq >= old.seq) {
        bucket[m.id] = old && (old.thinkStartedAt || old.thinkEndedAt) ? { ...m, thinkStartedAt: old.thinkStartedAt, thinkEndedAt: old.thinkEndedAt } : m;
      }
      messages[m.conversationId] = bucket;
      if (!isEphemeralId(m.conversationId) && !isEphemeralId(m.id)) maxSeq = Math.max(maxSeq, m.seq);
    }
  }
  set({ conversations, messages, providers, projects, presets, templates, settings, v3, lastSeq: maxSeq });
}

export function applySync(r: SyncResponse) {
  applyUpsert(r, r.seq);
}

/** Local ids of the ephemeral conversations in memory. */
export const getEphemeralIds = (): string[] => ephemeralConvIds(state.conversations);

/** Removes a destroyed ephemeral chat and its messages from memory (nothing is persisted). Non-ephemeral ids are ignored. */
export function destroyEphemeralLocal(convId: string): void {
  if (!isEphemeralId(convId) && !isEphemeralRow(state.conversations[convId])) return;
  if (!state.conversations[convId] && !state.messages[convId]) return;
  const r = dropEphemeralFrom(state.conversations, state.messages, new Set([convId]));
  set({ conversations: r.conversations, messages: r.messages });
}

/**
 * WS `ephemeral_state` (authoritative): drops every local ephemeral chat that is not listed,
 * then upserts the listed ones (newer seq wins). Ephemeral rows never move lastSeq.
 */
export function applyEphemeralState(m: { conversations: Conversation[]; messages: Message[] }): void {
  const listedConvs = (m.conversations || []).filter((c) => isEphemeralRow(c));
  const listed = new Set(listedConvs.map((c) => c.id));
  const keys = new Set([...Object.keys(state.conversations), ...Object.keys(state.messages)]);
  const stale = new Set<string>();
  for (const k of keys) {
    if ((isEphemeralId(k) || isEphemeralRow(state.conversations[k])) && !listed.has(k)) stale.add(k);
  }
  if (stale.size) {
    const r = dropEphemeralFrom(state.conversations, state.messages, stale);
    set({ conversations: r.conversations, messages: r.messages });
  }
  const listedMsgs = (m.messages || []).filter((x) => listed.has(x.conversationId) && isEphemeralId(x.conversationId));
  applyUpsert({ conversations: listedConvs, messages: listedMsgs });
}

/** Local-only patch of the synced settings doc (optimistic; the server upsert replaces it). */
export function patchSettingsLocal(p: Partial<Settings>) {
  const base: Settings = state.settings || { systemPrompt: null, effort: null, params: null, devMode: false, seq: 0 };
  set({ settings: { ...base, ...p } });
}
/** Local-only patch of a conversation (e.g. headId while a send is in flight). Keeps its seq. */
export function patchConversationLocal(id: string, p: Partial<Conversation>) {
  const c = state.conversations[id];
  if (!c) return;
  set({ conversations: { ...state.conversations, [id]: { ...c, ...p } } });
}

export function applyDelta(messageId: string, conversationId: string, text: string, kind: 'text' | 'reasoning' = 'text') {
  const bucket = state.messages[conversationId] || {};
  const old = bucket[messageId];
  const now = Date.now();
  const base: Message = old || {
    id: messageId, conversationId, role: 'assistant', content: '', status: 'streaming', createdAt: now, seq: 0,
    parentId: state.conversations[conversationId]?.headId,
  };
  const next: Message = { ...base, status: base.status === 'done' ? base.status : 'streaming' };
  if (kind === 'reasoning') {
    next.reasoning = (base.reasoning || '') + text;
    if (!next.thinkStartedAt) next.thinkStartedAt = now;
  } else {
    next.content = base.content + text;
    if (next.thinkStartedAt && !next.thinkEndedAt) next.thinkEndedAt = now;
  }
  set({ messages: { ...state.messages, [conversationId]: { ...bucket, [messageId]: next } } });
}

/** WS snapshot: replace the content of messages that are still streaming on the server. */
export function applySnapshot(items: { id: string; conversationId: string; content: string; reasoning?: string | null; status: Message['status']; toolCalls?: Message['toolCalls']; sources?: Message['sources']; phases?: Message['phases'] }[]) {
  if (!items?.length) return;
  const messages = { ...state.messages };
  for (const it of items) {
    const bucket = { ...(messages[it.conversationId] || {}) };
    const old = bucket[it.id];
    bucket[it.id] = old
      ? { ...old, content: it.content, status: it.status, ...(it.reasoning !== undefined ? { reasoning: it.reasoning } : {}), ...(it.toolCalls !== undefined ? { toolCalls: it.toolCalls } : {}), ...(it.sources !== undefined ? { sources: it.sources } : {}), ...(it.phases !== undefined ? { phases: it.phases } : {}) }
      : {
          id: it.id, conversationId: it.conversationId, role: 'assistant', content: it.content, reasoning: it.reasoning ?? null, status: it.status,
          ...(it.toolCalls !== undefined ? { toolCalls: it.toolCalls } : {}), ...(it.sources !== undefined ? { sources: it.sources } : {}),
          ...(it.phases !== undefined ? { phases: it.phases } : {}),
          createdAt: Date.now(), seq: 0, parentId: state.conversations[it.conversationId]?.headId,
        };
    messages[it.conversationId] = bucket;
  }
  set({ messages });
}

/** WS `tool` frame: insert/replace one tool call (by id) in the message's trace. */
export function applyToolCall(messageId: string, conversationId: string, call: ToolCall) {
  if (!call || !call.id) return;
  const bucket = state.messages[conversationId] || {};
  const old = bucket[messageId];
  const base: Message = old || {
    id: messageId, conversationId, role: 'assistant', content: '', status: 'streaming', createdAt: Date.now(), seq: 0,
    parentId: state.conversations[conversationId]?.headId,
  };
  const list = (base.toolCalls || []).slice();
  const i = list.findIndex((c) => c.id === call.id);
  if (i >= 0) list[i] = { ...list[i], ...call }; else list.push(call);
  set({ messages: { ...state.messages, [conversationId]: { ...bucket, [messageId]: { ...base, toolCalls: list } } } });
}

/** WS error frame: stop showing the pending state. */
export function failPending(messageId?: string) {
  const messages = { ...state.messages };
  let changed = false;
  for (const cid of Object.keys(messages)) {
    let bucket: Record<string, Message> | null = null;
    for (const m of Object.values(messages[cid])) {
      const hit = messageId ? m.id === messageId : m.seq === 0; // no id: drop unconfirmed local rows
      if (!hit) continue;
      bucket = bucket || { ...messages[cid] };
      if (m.role === 'assistant' && m.status === 'streaming') bucket[m.id] = { ...m, status: 'error' };
      else if (!messageId && m.seq === 0) delete bucket[m.id];
      changed = true;
    }
    if (bucket) messages[cid] = bucket;
  }
  if (changed) set({ messages });
}

// local-only optimistic message (seq 0 so any server row replaces it)
export function addLocalMessage(m: Message) {
  applyUpsert({ messages: [m] });
}

export function sortedConversations(convs: Record<string, Conversation>): Conversation[] {
  return Object.values(convs).filter((c) => !c.deleted).sort((a, b) => b.updatedAt - a.updatedAt);
}
export function activeProviders(p: Record<string, Provider>): Provider[] {
  return Object.values(p).filter((x) => !x.deleted).sort((a, b) => a.name.localeCompare(b.name));
}
export function activeProjects(p: Record<string, Project>): Project[] {
  return Object.values(p).filter((x) => !x.deleted).sort((a, b) => a.name.localeCompare(b.name));
}
export function activePresets(p: Record<string, PromptPreset>): PromptPreset[] {
  return Object.values(p).filter((x) => !x.deleted).sort((a, b) => a.name.localeCompare(b.name));
}
export function activeTemplates(t: Record<string, Template>): Template[] {
  return Object.values(t).filter((x) => !x.deleted).sort((a, b) => a.name.localeCompare(b.name));
}

/** WS `phase` frame: open a phase record (start) or close the matching open one (end). Unknown message => no-op. */
export function applyPhase(f: { messageId: string; conversationId: string; phase: PhaseName; state: 'start' | 'end'; label?: string; at: number; id?: string }) {
  const bucket = state.messages[f.conversationId];
  const old = bucket?.[f.messageId];
  if (!bucket || !old) return;
  const id = f.id ?? f.phase;
  let list = (old.phases || []).slice();
  if (f.state === 'start') {
    list.push({ id, phase: f.phase, label: f.label, start: f.at, end: null });
    if (list.length > 100) list = list.slice(list.length - 100);
  } else {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].id === id && list[i].end === null) { list[i] = { ...list[i], end: f.at }; break; }
    }
  }
  set({ messages: { ...state.messages, [f.conversationId]: { ...bucket, [f.messageId]: { ...old, phases: list } } } });
}

/** Drops an optimistic (unconfirmed, seq 0) message; true when it was removed. */
export function discardLocalMessage(convId: string, id: string): boolean {
  const old = state.messages[convId]?.[id];
  if (!old || old.seq !== 0) return false;
  const bucket = { ...state.messages[convId] };
  delete bucket[id];
  set({ messages: { ...state.messages, [convId]: bucket } });
  return true;
}
