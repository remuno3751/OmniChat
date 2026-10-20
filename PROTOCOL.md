# OmniChat protocol (contract between server/ and app/)

Server: Node 24 + TypeScript (ESM, run with tsx), Fastify 5, `ws`, built-in `node:sqlite` (DatabaseSync). Default port 8787 (env PORT), DB at ./data/omnichat.db (env DB_PATH).
Client: Expo (React Native + Web), TypeScript, in app/.

## Auth
- `POST /auth/register` `{username,password}` -> `{userId,username,token}`
- `POST /auth/login` same body/response
- All other REST: header `Authorization: Bearer <token>`. WebSocket: `ws://host/ws?token=<token>`.
- Errors: HTTP 4xx with `{error: string}`.

## Data model (JSON, camelCase; ids are client-generated UUIDs; times = epoch ms)
```ts
type Role = "user" | "assistant";
type MessageStatus = "done" | "streaming" | "error" | "stopped";
interface Conversation { id; title; providerId: string|null; model: string|null; createdAt; updatedAt; deleted: boolean; seq: number }
interface Message { id; conversationId; role: Role; content: string; status: MessageStatus; createdAt; seq: number }
interface Provider { id; name; kind: string; baseUrl: string; model: string; hasKey: boolean; deleted: boolean; seq: number } // apiKey NEVER returned
```
Every row has a server-assigned monotonic global `seq` that increases on every change (including soft delete). Last-write-wins.

## REST (all authed)
- `GET /sync?since=N` -> `{seq, conversations: Conversation[], messages: Message[], providers: Provider[]}` (rows with seq > N, deleted rows included; `seq` = highest seq returned or N). Initial sync since=0.
- `PUT /conversations/:id` `{title?, providerId?, model?}` upsert (creates if missing, default title "New chat") -> Conversation
- `DELETE /conversations/:id` soft delete -> Conversation
- `PUT /providers/:id` `{name, kind, baseUrl, model, apiKey?}` upsert (omit apiKey to keep existing) -> Provider
- `DELETE /providers/:id` -> Provider
- `GET /provider-kinds` -> `{kinds: string[]}`   (initially `["openai-compatible"]`)
- Every mutation is also pushed to all of the user's WS connections as an `upsert`.

## WebSocket
Client -> server:
- `{type:"send", conversationId, content, userMessageId, assistantMessageId}` : server stores the user message, creates assistant message (status "streaming"), streams the reply from the conversation's provider, persists. Conversation must already exist (client PUTs it first). Auto-title "New chat" conversations from the first user message (first 40 chars).
- `{type:"stop", messageId}` : abort generation, status "stopped".
Server -> client (to ALL the user's connected devices, so other devices watch live and can continue):
- `{type:"upsert", conversations?: Conversation[], messages?: Message[], providers?: Provider[]}`
- `{type:"delta", messageId, conversationId, text}` : append `text` to that message content (not persisted per delta; the final message arrives via `upsert` with status done/error/stopped; on error put the error text in content).
- `{type:"hello", seq}` right after connect.
Clients should call `GET /sync?since=lastSeq` on (re)connect and apply upserts by id, replacing when incoming seq >= stored seq.

## Provider plugin interface (server/src/providers/index.ts)
```ts
export interface ChatMessage { role: "system"|"user"|"assistant"; content: string }
export interface ProviderConfig { kind: string; baseUrl: string; apiKey: string; model: string }
export interface StreamRequest { messages: ChatMessage[]; model: string; signal: AbortSignal }
export interface ChatProvider { stream(req: StreamRequest): AsyncIterable<string> }
export function registerProvider(kind: string, factory: (cfg: ProviderConfig) => ChatProvider): void
export function createProvider(cfg: ProviderConfig): ChatProvider   // throws on unknown kind
export function providerKinds(): string[]
```
`openai-compatible` streams `POST {baseUrl}/chat/completions` (SSE), yields content deltas; throws Error with readable message (include HTTP status/body snippet) on failure. Future kinds (DeepSeek-native, a Claude Code remote-agent bridge) register the same way.

## Provider kind `dsh-bridge` and /bridges
Kind `dsh-bridge` drives the DeepSeek Harness agent on a user PC through an outbound bridge daemon (see BRIDGE.md). `baseUrl` = bridge name, `model` is free text, no apiKey. Only the latest user message is sent; the dsh session id is kept per conversation server-side (table `agent_sessions`). Tool calls/failures are rendered as markdown in the assistant text; Stop sends `cancel` to the bridge. Offline bridge => message status `error` ("Bridge '<name>' is offline. Start the bridge on your PC.").

- `GET /bridges` (authed) -> `{bridges:[{name, cwd, online:true}]}` (the user's currently connected bridges).
- WS `/bridge?token=&name=` is for the bridge daemon only (not the app); bad token => HTTP 401.
- `StreamRequest` has an optional `context?: {userId, conversationId, providerId}` (backward compatible).

## Model listing (BRIDGE-v2.md A)
- `GET /providers/:id/models` (authed; 404 if not the user's / deleted) -> `{models:[{id,name}], error?}`. Never fails for upstream problems (`error` carries the text). `openai-compatible`: `GET {baseUrl}/models` with the key (5 s timeout, 5 s cache on success only, errors are never cached; `?refresh=1` bypasses the cache). `dsh-bridge`: models last reported by the named bridge (`id` = modelRef `<provider>::<id>`, `name` = `<id> (<provider>)`), `[]` if the bridge is offline. Other kinds: `[]`.
- `GET /models` (authed; `?refresh=1` supported) -> `{groups:[{providerId, providerName, kind, models:[{id,name}], error?}]}` over the user's non-deleted providers (fetched in parallel).
- For dsh-bridge conversations `conversations.model` holds a modelRef; the server sends it as `run.model` only when it contains `::`.
- `StreamRequest.context` additionally carries optional `userMessageId` / `assistantMessageId` of the active run.
- Bridge->server frames `models` and `sessions` (mirror) are handled as described in BRIDGE-v2.md; conversations auto-created from dsh sessions have id `dsh-<sessionId>`.

## Automatic model recognition
- Model lists drop non-chat ids (`/embed|embedding|rerank|whisper|tts|moderation/i`) for openai-compatible and dsh-bridge lists; `?all=1` on `GET /providers/:id/models` and `GET /models` includes them.
- `fetchedAt` (epoch ms of the underlying fetch; cache hits keep the original time) is returned by `GET /providers/:id/models` and in each `GET /models` group.
- `GET /local-servers` (authed) -> `{servers:[{name, kind:"openai-compatible", baseUrl, models:number}]}`: well-known servers on the machine running the server that answer `GET {baseUrl}/models` within 800 ms (LM Studio :1234, Ollama :11434, llama.cpp :8080, vLLM :8000; `models` = chat models), minus any already configured as a non-deleted provider with the same baseUrl (trailing slash and 127.0.0.1/localhost normalized). Cached 5 s.
- WS server -> client: `{type:"models_changed", providerIds:string[]}` when a provider's chat-model list differs from its previous successful fetch. The server polls the user's providers every 15 s while the user has an open `/ws`; errors never trigger it. Clients should re-fetch `GET /models` for those providers.
- Bridge: reports only currently served models (polls upstream `/models` every 10 s, loopback/private hosts only); see bridge/README.md.
