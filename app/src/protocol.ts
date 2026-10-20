import type { LoadPolicy } from './modelLoad';

export type Role = 'user' | 'assistant';
export type MessageStatus = 'done' | 'streaming' | 'error' | 'stopped';
export type Effort = 'off' | 'low' | 'medium' | 'high' | 'max';
export type SystemMode = 'append' | 'replace';

export interface SamplingParams {
  temperature?: number | null;
  topP?: number | null;
  topK?: number | null;
  minP?: number | null;
  repeatPenalty?: number | null;
  seed?: number | null;
  stop?: string[] | null;
  maxTokens?: number | null;
  /** phase 4 (dev): top-N logprobs 0..20, llama.cpp GBNF grammar, extra request body keys */
  logprobs?: number | null;
  grammar?: string | null;
  extraBody?: Record<string, any> | null;
}

export interface Conversation {
  id: string;
  title: string;
  providerId: string | null;
  model: string | null;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
  seq: number;
  // v3 (all optional: absent on an old server)
  projectId?: string | null;
  systemPrompt?: string | null;
  systemMode?: SystemMode;
  effort?: Effort | null;
  params?: SamplingParams | null;
  headId?: string | null;
  /** phase 3: null/absent = inherit; [] = none */
  tools?: string[] | null;
  searchMode?: SearchMode | null;
  /** per-chat context-overflow override (null/absent = follow the user default) */
  contextOverflow?: ContextOverflow | null;
  /** phase 4 */
  responseFormat?: ResponseFormat | null;
  /** phase 5: pinned to the top of the sidebar. Absent on an older server = not pinned. */
  pinned?: boolean;
  pinnedAt?: number | null;
  /** v4: chat / code split (absent on an older server = 'chat') */
  mode?: ChatMode;
  /** Code: working folder on the PC (absent on an older server, null = unknown) */
  cwd?: string | null;
  codeStatus?: CodeStatus;
  /** v7: ephemeral chat (id starts with eph_); absent on an older server */
  ephemeral?: boolean;
}
export type ChatMode = 'chat' | 'code';
export type CodeStatus = 'idle' | 'running' | 'awaiting_approval' | 'done' | 'error';
export type PhaseName = 'thinking' | 'searching' | 'tool' | 'subagent' | 'answering';
export interface PhaseRecord { id: string; phase: PhaseName; label?: string; start: number; end: number | null }
export interface FileChange { path: string; status: 'added' | 'modified' | 'deleted' | 'renamed'; additions: number; deletions: number; patch?: string }
export interface AgentRecord { id: string; role: string; status: 'running' | 'done' | 'error'; startedAt: number; endedAt: number | null; summary?: string; log?: string }
export type SearchMode = 'off' | 'auto' | 'always' | 'smart';
export type ToolPermission = 'network' | 'filesystem-read' | 'filesystem-write' | 'shell';
export interface ToolInfo {
  name: string; description: string; parameters?: any; permissions: ToolPermission[];
  source: 'builtin' | 'plugin'; pluginId: string | null; available: boolean; error?: string; needsApproval?: boolean;
}
export type ToolCallStatus = 'pending' | 'running' | 'done' | 'error' | 'denied';
export interface ToolCall {
  id: string; name: string; arguments: any; status: ToolCallStatus;
  result?: string; error?: string; durationMs?: number; startedAt: number;
}
export interface SearchSource { index: number; title: string; url: string; snippet?: string }
/** Web search methods (PROTOCOL-v6 1.1b). */
export type SearchBackendId = 'searxng' | 'builtin' | 'api';
export type SearchEngineStateName = 'ok' | 'cooldown' | 'error' | 'disabled';
/** One engine inside a search option (builtin engines, or brave/tavily). */
export interface SearchEngineState {
  id: string; label?: string; enabled: boolean; state: SearchEngineStateName;
  keySet?: boolean; lastError?: string; lastOkAt?: number | null;
}
export interface SearchOption {
  id: SearchBackendId; configured: boolean; reachable: boolean; state: 'ok' | 'error' | 'disabled';
  lastError?: string; host?: string; engines?: SearchEngineState[];
}
/** GET /search/status. The first fields are the pre-v6 shape and stay for older UI code. */
export interface SearchStatus {
  configured: boolean; backend?: string; host?: string; reachable?: boolean; error?: string;
  /** v6: the selected mode, the mode that answers now, the fallback flag, per-option state */
  mode?: SearchBackendId; active?: SearchBackendId; fallback?: boolean;
  options?: SearchOption[]; engines?: SearchEngineState[];
  lastUsed?: { usedBackend: string; mode: string; at: number } | null;
}
/** GET /search/config (any user) and the response of PUT /search/config. */
export interface SearchConfig {
  mode: SearchBackendId; fallback: boolean; searxngHost: string | null;
  engines: { builtin: string[]; api: string[] }; keySet: { brave: boolean; tavily: boolean };
}
/** PUT /search/config body (admin). Keys: a string sets, null removes, absent keeps. */
export interface SearchConfigPatch {
  mode?: SearchBackendId; fallback?: boolean; searxngUrl?: string | null;
  engines?: { builtin?: string[]; api?: string[] };
  braveApiKey?: string | null; tavilyApiKey?: string | null;
}
export interface SearchResult { title: string; url: string; snippet?: string }
/** PROTOCOL-v7 attachments: metadata of a file attached to a message (bytes via GET /attachments/:id). */
export interface Attachment { id: string; name: string; mime: string; kind: 'image' | 'document' | 'audio' | 'other'; size: number; status: 'ready' | 'deleted' }

export interface Message {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  status: MessageStatus;
  createdAt: number;
  seq: number;
  /** v3 tree link; undefined on an old server (=> linear chain by createdAt). */
  parentId?: string | null;
  /** phase 2: full thinking text (null/absent = none). */
  reasoning?: string | null;
  /** phase 2: speed metrics of a finished assistant reply. */
  metrics?: Metrics | null;
  /** phase 3: tool-call trace and web-search sources (null/absent = none). */
  toolCalls?: ToolCall[] | null;
  sources?: SearchSource[] | null;
  /** v4: staged status history (folded in the UI), Code run file changes (patch omitted when > 20 KB: GET /messages/:id/changes) and sub-agents */
  phases?: PhaseRecord[] | null;
  changes?: FileChange[] | null;
  agents?: AgentRecord[] | null;
  /** client-only (never synced): when the reasoning lane started/ended streaming, epoch ms. */
  thinkStartedAt?: number;
  thinkEndedAt?: number;
  /** v7 attachments (absent on an older server); status 'deleted' = removed later */
  attachments?: Attachment[] | null;
}
export interface Metrics {
  providerId?: string | null; providerKind?: string | null; model?: string | null;
  quantization?: string | null; contextLength?: number | null;
  promptTokens?: number | null; completionTokens?: number | null; reasoningTokens?: number | null;
  ttftMs?: number | null; totalMs?: number | null; prefillTps?: number | null; decodeTps?: number | null;
  source?: 'backend' | 'estimated';
  createdAt?: number;
  /** phase 4: set when a responseFormat was used */
  jsonValid?: boolean | null;
  jsonError?: string | null;
}
export type ContextOverflow = 'truncate' | 'summarize' | 'stop';
export interface ContextUsage {
  limit: number | null;
  /** 'default' = the assumed defaultContextLength (phase 5) */
  limitSource: 'backend' | 'override' | 'default' | 'unknown';
  total: number;
  used: { system: number; history: number; attachments: number; tools: number; input: number };
  reasoning: number;
  lastReasoning: number;
  estimated: boolean;
  reserve: number;
  fits: boolean;
  headId: string | null;
  /** tokens the compaction summary occupies (after /compact) */
  summaryTokens?: number;
}
export interface StatGroup {
  count?: number; n?: number; avgTtftMs: number | null; avgPrefillTps: number | null; avgDecodeTps: number | null;
  avgCompletionTokens?: number | null; estimatedShare?: number | null;
}
export interface StatModelRow extends StatGroup {
  providerId: string; providerName?: string; model: string; quantization?: string | null; contextLength?: number | null; count: number;
}
export interface StatPoint { t: number; model: string; decodeTps: number | null; prefillTps: number | null; ttftMs: number | null }
export interface StatsResponse { overall: StatGroup; recent: StatGroup; byModel: StatModelRow[]; series: StatPoint[] }
export type Route = 'loopback' | 'lan' | 'vpn' | 'external';
export interface Provider {
  id: string;
  name: string;
  kind: string;
  /** absent on a shared provider seen by an ordinary user (URLs and keys are never sent to them) */
  baseUrl?: string;
  /** absent on a shared provider seen by an ordinary user */
  model?: string;
  hasKey?: boolean;
  /** How reasoning effort is sent: null/'standard' | 'xhigh' | 'think-toggle' | 'none'. Absent on old servers. */
  effortProfile?: string | null;
  deleted?: boolean;
  /** absent on a shared provider seen by an ordinary user */
  seq?: number;
  /** PROTOCOL-v7 shared providers: the owner's flag on the owner's own provider (absent on old servers). */
  shared?: boolean;
  /** true on a shared provider another user (the admin) owns: no edit, delete or key input here. */
  readOnly?: boolean;
  /** shared providers seen by an ordinary user: 'all' or the model ids this user may use. */
  allowedModels?: 'all' | string[];
}
export interface Project {
  id: string;
  name: string;
  systemPrompt: string | null;
  systemMode: SystemMode;
  defaultProviderId: string | null;
  defaultModel: string | null;
  effort: Effort | null;
  params: SamplingParams | null;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
  seq: number;
  /** phase 3 */
  tools?: string[] | null;
  searchMode?: SearchMode | null;
  /** phase 4 */
  responseFormat?: ResponseFormat | null;
  /** v4 */
  mode?: ChatMode;
}
export interface PromptPreset {
  id: string;
  name: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
  seq: number;
}
export interface Settings {
  systemPrompt: string | null;
  effort: Effort | null;
  params: SamplingParams | null;
  devMode: boolean;
  seq: number;
  /** phase 2 (absent on an older server) */
  contextOverflow?: ContextOverflow;
  contextLimits?: Record<string, number> | null;
  /** phase 3 (absent on an older server) */
  tools?: string[] | null;
  searchMode?: SearchMode;
  autoTitle?: boolean;
  /** re-title every N exchanges, 0..50; 0 = first title only (absent on an older server) */
  titleEvery?: number;
  titleModel?: string | null;
  modelParams?: Record<string, SamplingParams> | null;
  /** phase 5 (absent on an older server) */
  defaultContextLength?: number | null;
  /** percent 50..95; null = off */
  contextCompressAt?: number | null;
  /** percent 20..80 */
  contextCompressTarget?: number;
  /** v4 (absent on an older server) */
  notify?: { done: boolean; approval: boolean; error: boolean };
  /** GET never returns the URL; PUT {notifyUrl: string|null} sets it */
  notifyUrlSet?: boolean;
  notifyUrl?: string | null;
  activePetId?: string | null;
  /** v7: ephemeral chats idle timeout, integer 1..1440 (absent on an older server) */
  ephemeralIdleMinutes?: number;
  /** v7 attachments: per-model image support override, key '<providerId>::<model>' */
  modelVision?: Record<string, boolean> | null;
}
export interface Device { id: string; name: string; platform: string; createdAt: number; lastSeenAt: number; current: boolean }
export interface ApiKeyInfo { id: string; name: string; prefix: string; createdAt: number; lastUsedAt: number | null }
export interface ApiKeyCreated { id: string; name: string; key: string; prefix: string; createdAt: number }

export interface AuthResponse { userId: string; username: string; token: string; deviceId?: string; isAdmin?: boolean }
export interface SyncResponse {
  seq: number;
  conversations: Conversation[];
  messages: Message[];
  providers: Provider[];
  /** PROTOCOL-v7: whether ordinary users may add their own providers (absent on old servers) */
  allowOwnProviders?: boolean;
  projects?: Project[];
  presets?: PromptPreset[];
  settings?: Settings;
  templates?: Template[];
}

export type ClientMsg =
  | {
      type: 'send'; conversationId: string; content: string; userMessageId: string; assistantMessageId: string;
      parentId?: string | null; effort?: Effort; params?: SamplingParams; responseFormat?: ResponseFormat;
      /** PROTOCOL-v7: only consulted on a model conflict; useModel only with use_loaded */
      loadPolicy?: LoadPolicy; useModel?: string;
      /** v7 attachments: ready, unattached uploads to attach to this message */
      attachmentIds?: string[];
    }
  | { type: 'regenerate'; conversationId: string; messageId: string; assistantMessageId: string; effort?: Effort; params?: SamplingParams; responseFormat?: ResponseFormat; loadPolicy?: LoadPolicy; useModel?: string }
  | { type: 'compare'; compareId: string; prompt: string; systemPrompt?: string | null; targets: CompareTarget[]; sequential?: boolean }
  | { type: 'compare_stop'; compareId: string }
  | { type: 'stop'; messageId: string }
  | { type: 'ping'; t: number }
  | { type: 'ephemeral_end'; conversationId: string }
  | { type: 'tool_approval_reply'; approvalId: string; decision: 'once' | 'always' | 'deny' };

export interface UpsertPayload {
  conversations?: Conversation[];
  messages?: Message[];
  providers?: Provider[];
  projects?: Project[];
  presets?: PromptPreset[];
  settings?: Settings;
  templates?: Template[];
}
/** Maintenance mode (GET /maintenance, hello, { type: 'maintenance' }). eta = epoch ms or null. */
export interface Maintenance {
  enabled: boolean;
  message: string;
  eta: number | null;
  updatedAt: number;
}

export type ServerMsg =
  | ({ type: 'upsert' } & UpsertPayload)
  | { type: 'delta'; messageId: string; conversationId: string; text: string; kind?: 'text' | 'reasoning' }
  | { type: 'hello'; seq: number; route?: Route; serverTime?: number; maintenance?: Maintenance; allowOwnProviders?: boolean }
  /** shared providers or their user grants changed: re-fetch the provider list and the model list */
  | { type: 'providers-changed' }
  /** maintenance mode changed (sent to every connection) */
  | { type: 'maintenance'; maintenance: Maintenance }
  | { type: 'pong'; t: number }
  | { type: 'snapshot'; messages: { id: string; conversationId: string; content: string; reasoning?: string | null; status: MessageStatus; toolCalls?: ToolCall[] | null; sources?: SearchSource[] | null; phases?: PhaseRecord[] | null }[] }
  /** v7 model load: codes model_conflict / model_load_failed carry `conflict` (see docs/PROTOCOL-v7-modelload.md) */
  | { type: 'error'; message: string; messageId?: string; code?: string; conversationId?: string; conflict?: any }
  /** v7: progress of a model load/unload policy before a chat turn (not persisted) */
  | { type: 'model_load'; conversationId: string; messageId?: string; providerId?: string; phase: 'unloading' | 'loading' | 'ready'; model: string; unloading?: string[] }
  /** v7: authoritative list of live ephemeral chats of this user (sent after hello/snapshot) */
  | { type: 'ephemeral_state'; conversations: Conversation[]; messages: Message[]; idleMinutes: number }
  /** v7: an ephemeral chat was destroyed (broadcast to all devices of the user) */
  | { type: 'ephemeral_destroyed'; conversationId: string; reason: 'ended' | 'idle' | 'logout' | 'disconnected' | 'limit' }
  | { type: 'models_changed'; providerIds: string[] }
  | { type: 'compare_delta'; compareId: string; index: number; kind: 'text' | 'reasoning'; text: string }
  | ({ type: 'compare_done'; compareId: string; index: number } & CompareResultBody)
  | { type: 'compare_complete'; compareId: string }
  | { type: 'bench_progress'; runId: string; done: number; total: number; current?: string | null }
  | { type: 'bench_done'; runId: string; status: string }
  | { type: 'tool'; messageId: string; conversationId: string; call: ToolCall }
  | { type: 'tool_approval'; approvalId: string; messageId: string; conversationId: string; tool: string; arguments: any; permissions: ToolPermission[]; codeStatus?: CodeStatus }
  | { type: 'phase'; conversationId: string; messageId: string; phase: PhaseName; state: 'start' | 'end'; label?: string; at: number; id?: string }
  | { type: 'notify'; kind: 'done' | 'approval' | 'error'; conversationId: string; title: string; body: string; at: number }
  | { type: 'checkpoint'; conversationId: string; messageId: string | null; checkpointId: string; createdAt: number; dirty: boolean }
  | { type: 'checkpoint_unavailable'; conversationId: string; messageId: string | null; reason: string }
  // loose v4 checkpoint frames (bridge may add fields; the app only needs conversationId + checkpointId/unavailable)
  | { type: 'checkpoint'; conversationId: string; checkpointId?: string; unavailable?: string; [k: string]: any }
  | { type: 'checkpoint_unavailable'; conversationId: string; unavailable?: string; [k: string]: any };

export interface ModelState { loaded?: boolean; vramBytes?: number; sizeBytes?: number; quantization?: string; contextLength?: number; loadedContextLength?: number; /** LM Studio publisher (e.g. 'google'); used to look up the model logo */ publisher?: string }
export interface ModelInfo {
  id: string;
  name: string;
  /** whether the model supports the effort setting (absent on old servers => unknown). */
  effort?: 'supported' | 'unsupported' | 'unknown';
  state?: ModelState;
  /** dsh-bridge: the dsh provider group display name (absent on old plugins). */
  group?: string;
  /** dsh-bridge: the model is the one currently selected in the dsh GUI. */
  current?: boolean;
  /** dsh-bridge: the model was imported from OmniChat into dsh. */
  imported?: boolean;
  /** v7: can the model read images (absent on an older server = unknown) */
  vision?: 'yes' | 'no' | 'unknown';
}
export interface ModelGroup {
  providerId: string;
  providerName: string;
  kind: string;
  models: ModelInfo[];
  /** The provider's own default model id (dsh bridge), preferred for new chats. */
  defaultModel?: string;
  error?: string;
  /** epoch ms when the server fetched this list (absent on old servers). */
  fetchedAt?: number;
  capabilities?: { load: boolean; unload: boolean; vram: boolean };
  /** client-side only: the dsh group name when a bridge group is split by ModelInfo.group (codeModelView). */
  subKey?: string;
}
export interface LocalServer { name: string; kind: string; baseUrl: string; models: number; modelIds?: string[] }
export interface ModelsResponse { groups: ModelGroup[] }
export interface ProviderModelsResponse { models: ModelInfo[]; error?: string }

export interface DebugInfo {
  model: string;
  providerKind: string;
  final: {
    messages: { role: string; content: string }[];
    params?: any;
    effort?: { requested?: string | null; resolved?: string | null; sentAs?: any };
    contextAction?: any;
  };
  response: { status: string; finishReason?: string; usage?: any; raw?: any; timings?: any; logprobs?: any };
  createdAt: number;
}

// ---- phase 4: developer features ----
export type ResponseFormat = { type: 'json_object' } | { type: 'json_schema'; name?: string; schema: any };
export interface CompareTarget { providerId: string; model: string; effort?: Effort | null; params?: SamplingParams | null; responseFormat?: ResponseFormat | null }
export interface CompareResultBody { status: 'done' | 'error' | 'stopped'; content: string; reasoning: string; metrics?: Metrics | null; error?: string }
export interface CompareResult extends CompareResultBody { index?: number }
/** GET /comparisons/:id (the list endpoint may omit results) */
export interface ComparisonRow {
  id: string; createdAt: number; prompt: string; systemPrompt?: string | null; targets: CompareTarget[]; results?: CompareResult[];
}
export interface BenchSet { id: string; name: string; prompts: string[]; systemPrompt?: string | null; createdAt?: number; updatedAt?: number }
export interface BenchTarget { providerId: string; model: string; effort?: Effort | null; params?: SamplingParams | null }
export interface BenchResultRow {
  targetIndex: number; promptIndex: number; repeat: number; status: string; ttftMs?: number | null; prefillTps?: number | null; decodeTps?: number | null;
  completionTokens?: number | null; reasoningTokens?: number | null; totalMs?: number | null; source?: string; error?: string; content?: string;
}
export interface BenchSummaryRow {
  targetIndex: number; providerName?: string; model: string; quantization?: string | null; contextLength?: number | null; n: number;
  avgTtftMs?: number | null; avgPrefillTps?: number | null; avgDecodeTps?: number | null; p50DecodeTps?: number | null; minDecodeTps?: number | null; maxDecodeTps?: number | null;
  errors?: number; estimatedShare?: number | null;
}
export interface BenchRun {
  id: string; setId?: string; setName?: string; status: string; startedAt?: number; finishedAt?: number | null; targets?: BenchTarget[]; repeats?: number;
  results?: BenchResultRow[]; summary?: BenchSummaryRow[]; total?: number; done?: number;
}
export interface TokenizeResponse { tokens: { id?: number; text: string }[]; count: number; exact: boolean; source: 'llama.cpp' | 'estimate' | string }

// ---- v4: Code operations, approval rules, templates, pets (PROTOCOL-v4.md) ----
export interface CodeSession { conversationId: string; title: string; projectId: string | null; cwd: string; bridge: string; codeStatus: CodeStatus; updatedAt: number; pendingApprovals: number }
export interface CodeCheckpoint { id: string; conversationId: string; messageId: string | null; bridge: string; cwd: string; ref: string | null; unavailable: string | null; dirty: boolean; createdAt: number }
export interface ApprovalRule { id: string; projectId: string | null; kind: 'tool' | 'command' | 'path'; pattern: string; action: 'allow' | 'deny' | 'ask'; createdAt: number; note: string | null }
export interface Template { id: string; projectId: string | null; name: string; body: string; description: string; kind: 'prompt' | 'action'; createdAt: number; updatedAt: number; deleted: boolean; seq: number }
export interface PetManifest { id: string; displayName: string; description?: string; spriteVersionNumber: 1 | 2; spritesheetPath: string }
export interface PetInfo { id: string; name: string; description: string; spriteVersionNumber: 1 | 2; mime: string; size: number; createdAt: number }

/* ---- Usage (token analytics; GET /usage/*) ---- */
export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  /** a subset of completionTokens */
  reasoningTokens: number;
  /** promptTokens + completionTokens */
  totalTokens: number;
  messages: number;
  chats: number;
  avgTokensPerAnswer: number;
  estimatedMessages: number;
}
export interface UsageSummary {
  from: number | null;
  to: number | null;
  tz: number;
  totals: UsageTotals;
  estimated: boolean;
  topModel: { providerId: string | null; providerName: string | null; model: string | null; totalTokens: number } | null;
}
export interface UsageDay {
  /** 'YYYY-MM-DD' in the requested tz */
  day: string;
  start: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  messages: number;
  estimatedMessages: number;
}
export interface UsageDaily { tz: number; days: UsageDay[]; estimated: boolean }
export interface UsageChatRow {
  conversationId: string;
  title: string;
  models: string[];
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  messages: number;
  estimatedMessages: number;
  lastActivity: number;
}
export interface UsageChats { chats: UsageChatRow[]; estimated: boolean }
export interface UsageModelRow {
  providerId: string | null;
  providerName: string | null;
  providerKind: string | null;
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  messages: number;
  estimatedMessages: number;
  /** fraction 0..1 of all tokens in the period */
  share: number;
}
export interface UsageModels { models: UsageModelRow[]; estimated: boolean }
/** POST /conversations/:id/compact */
export type CompactResult =
  | {
      ok: true; compacted: true; tokensBefore: number; tokensAfter: number;
      summarizedMessages: number; keptMessages: number; summaryTokens: number; estimated: boolean;
    }
  | { ok: true; compacted: false; reason: 'too_short' };
