# OmniChat protocol v3 (extends PROTOCOL.md; everything there still holds unless stated)

Phase 1 of NEXT-VERSION.md. Backward compatible where possible: old clients keep working against a v3 server (unknown fields ignored), new fields are optional/nullable. camelCase JSON, ids = client-generated UUIDs, times = epoch ms, every synced row has the global monotonic `seq` and is soft-deleted via `deleted:true`.

## 1. Types
```ts
type Effort = "low" | "medium" | "high" | "max";
interface SamplingParams { temperature?: number|null; topP?: number|null; topK?: number|null; minP?: number|null;
  repeatPenalty?: number|null; seed?: number|null; stop?: string[]|null; maxTokens?: number|null }   // null/absent = inherit
interface Project { id; name; systemPrompt: string|null; systemMode: "append"|"replace"; defaultProviderId: string|null;
  defaultModel: string|null; effort: Effort|null; params: SamplingParams|null; createdAt; updatedAt; deleted: boolean; seq }
interface PromptPreset { id; name; text; createdAt; updatedAt; deleted: boolean; seq }
interface Settings { systemPrompt: string|null; effort: Effort|null; params: SamplingParams|null; devMode: boolean; seq }   // one doc per user
// Conversation gains:
//   projectId: string|null; systemPrompt: string|null; systemMode: "append"|"replace"; effort: Effort|null;
//   params: SamplingParams|null; headId: string|null     (leaf message id of the CURRENT branch)
// Message gains:
//   parentId: string|null                                (tree; null = first message)
interface Device { id; name; platform: string; createdAt; lastSeenAt: number; current: boolean }   // current = the caller's device
interface ApiKeyInfo { id; name; prefix: string; createdAt; lastUsedAt: number|null }
```
`/sync` and WS `upsert` additionally carry `projects?: Project[]`, `presets?: PromptPreset[]`, `settings?: Settings`. `/sync?since=N` returns `settings` only if changed since N (else omitted).

## 2. Auth, devices, API keys
- `POST /auth/register {username,password,deviceName?,platform?}`: allowed if an admin already exists and env `ALLOW_REGISTRATION=1` (the new account is a regular user). With no users yet it is 403 `No administrator exists yet` (the first admin is created locally with `omnichat-admin` / `admin-cli.js`; env `OMNICHAT_OPEN_FIRST_REGISTRATION=1` restores the old test-only behaviour). Otherwise 403 `{error:"registration is disabled"}`. `POST /auth/login {username,password,deviceName?,platform?}`. Both return `{userId,username,token,deviceId,isAdmin}` and create a **device** with its own token (stored hashed). Missing deviceName => "Unknown device". Tokens issued by the old version keep working (migrated into devices named "Legacy").
- `GET /devices` -> `{devices: Device[]}`; `DELETE /devices/:id` revokes that device (its token stops working immediately and its open WS connections are closed with code 4001); `POST /auth/logout` revokes the caller's own device. Revoking the last/current device is allowed. `lastSeenAt` updated at most once per minute per device.
- API keys (developer feature, separate from device tokens): `POST /apikeys {name}` -> `{id,name,key,prefix,createdAt}` (the full `key` is shown ONCE, format `ocsk-<random>`; stored hashed), `GET /apikeys` -> `{keys: ApiKeyInfo[]}`, `DELETE /apikeys/:id`. API keys are accepted ONLY on `/v1/*`; device tokens are accepted on everything except `/v1/*`.
- `GET /ping` (no auth) -> `{t: <server epoch ms>}`; `GET /version` (no auth) -> `{name:"omnichat-server", version, webUi:boolean, searxng:boolean}`; `GET /healthz` -> 200 `ok`.
- The server may serve the web client: if dir `WEB_DIR` (default `./web`) exists, serve it at `/` with SPA fallback (non-API paths -> index.html). API/WS paths are never shadowed.
- Server env: `PORT` (8787), `HOST` (0.0.0.0), `DATA_DIR` (default `./data`; `DB_PATH` default `$DATA_DIR/omnichat.db`), `WEB_DIR`, `ALLOW_REGISTRATION`, `SEARXNG_URL` (optional, used in phase 3), `EFFORT_MAP` (path of effort map file, default `$DATA_DIR/effort-map.json`, created with defaults if missing).

## 3. OpenAI-compatible API (developer feature)
`Authorization: Bearer ocsk-…`
- `GET /v1/models` -> OpenAI list; model ids are `<providerName>/<modelId>` (providerName slugified: lowercase, spaces->`-`). dsh-bridge providers are NOT exposed.
- `POST /v1/chat/completions` with `model` (`<providerSlug>/<modelId>` or a bare id: first provider listing it), `messages`, `stream`, and sampling fields (`temperature, top_p, top_k, min_p, repeat_penalty, seed, stop, max_tokens, reasoning_effort`) forwarded to the backend. Stream and non-stream, OpenAI response shapes, errors as `{error:{message,type}}`. Stateless: nothing is stored in chat history. Abort on client disconnect.

## 4. Projects, presets, settings
- `PUT /projects/:id {name?, systemPrompt?, systemMode?, defaultProviderId?, defaultModel?, effort?, params?}` (upsert; default name "New project") -> Project; `DELETE /projects/:id` soft-deletes and **moves its conversations to Unclassified** (`projectId:null`, each conversation upserted/broadcast).
- `PUT /presets/:id {name?, text?}` / `DELETE /presets/:id`.
- `PUT /settings {systemPrompt?, effort?, params?, devMode?}` (partial merge) -> Settings.
- `PUT /conversations/:id` additionally accepts `projectId, systemPrompt, systemMode, effort, params, headId`. A conversation created inside a project with no explicit provider/model inherits the project's `defaultProviderId/defaultModel` at creation.
- All of the above are broadcast to the user's devices as `upsert` and included in `/sync`.

## 5. Context building (server, single function `buildContext`)
1. **System prompt**: pieces global (`settings.systemPrompt`) -> project -> conversation. Walk from global down: a piece with `systemMode:"replace"` discards everything above it, `"append"` (default) appends after a blank line. Global has no mode (always the base). Empty/whitespace pieces are skipped. Result is sent as ONE `system` message when non-empty.
2. **History** = the path root -> parent-of-new-message in the message tree (never other branches), only `done`/`stopped` messages with non-empty content, plus the new user message.
3. **Sampling params**: per key, first non-null of: one-shot (`send.params`) -> conversation -> project -> global. 
4. **Effort**: first non-null of: one-shot (`send.effort`) -> conversation -> project -> global. Mapped through the effort map (§7). Not sent if the model is known to not support reasoning.
The exact messages/params/effort/model sent are stored per assistant message (server-side, capped 256 KB) and exposed by `GET /messages/:id/debug` -> `{model, providerKind, final:{messages:[{role,content}], params, effort:{requested, resolved, sentAs}}, response:{status, finishReason?, usage?, raw?:any}, createdAt}` (404 if none). `raw` = the final raw backend JSON (non-stream) or the last SSE data object + collected usage/timings (stream). Developer mode only matters to the UI; the endpoint always works for the owner.

## 6. Branching, regenerate, edit
- Messages form a tree: `parentId`. The conversation's `headId` is the leaf of the current branch; the UI shows the path root->head. Migration: existing conversations get a linear chain by `createdAt` and `headId` = last message.
- WS `send` gains `parentId?: string|null` (default = conversation `headId`), `effort?`, `params?` (one-shot). **Edit & resend** = `send` with `parentId` = the parent of the edited user message (new sibling user message), new assistant reply under it; head moves to the new assistant message when it is created (so the branch is visible while streaming).
- WS `{type:"regenerate", conversationId, messageId /*the assistant message to redo*/, assistantMessageId, effort?, params?}`: creates a new assistant message with the same `parentId` as `messageId` (a sibling), streams it, head moves to it.
- `PUT /conversations/:id {headId}` switches branch (must be an existing message of that conversation; clients pick the deepest/latest leaf of a chosen sibling). Siblings of a message = messages with the same `parentId`, ordered by `createdAt`; UI shows `‹ 2/3 ›`.
- Stop (existing) works for both. `dsh-bridge` conversations are linear: `regenerate` and `parentId != head` are rejected with a `{type:"error", message}` WS frame; mirrored messages get parentId chained in order and `headId` kept at the last message.

## 7. Effort map
File `effort-map.json` (editable, reloaded when its mtime changes):
```json
{ "openai-compatible": { "low": {"reasoning_effort":"low"}, "medium": {"reasoning_effort":"medium"}, "high": {"reasoning_effort":"high"}, "max": {"reasoning_effort":"high"} },
  "dsh-bridge": { "low":"low", "medium":"medium", "high":"high", "max":"max" },
  "noReasoning": ["embed", "^gemma-?[0-9]-.*it$"],
  "reasoning": ["gpt-oss", "qwen3", "deepseek-r1", "r1", "o[134]", "reasoning", "think"] }
```
`reasoning` / `noReasoning` are case-insensitive regex lists on the model id: matching `noReasoning` => effort unsupported; matching `reasoning` => supported; neither => unknown (effort is still sent when chosen). `/models` entries gain `effort?: "supported"|"unsupported"|"unknown"`. For dsh-bridge the server forwards `run.effort` (bridge daemon/plugin may ignore it for now).

## 8. Model management (S3)
`/models` and `/providers/:id/models` entries gain optional `state?: {loaded?: boolean; vramBytes?: number; sizeBytes?: number; quantization?: string; contextLength?: number}`; groups gain `capabilities?: {load: boolean; unload: boolean; vram: boolean}`. Adapters (auto-chosen from the provider baseUrl by probing; cached): **LM Studio** `GET {origin}/api/v0/models` (state loaded/not-loaded, quantization, max_context_length) — load = `POST /api/v1/models/load {model}` (LM Studio 0.4+; falls back to a 1-token chat request = JIT on 404), unload = `POST /api/v1/models/unload {instance_id}` per `loaded_instances` from `GET /api/v1/models` (capabilities.unload=true only if that GET works). Embedding models are skipped; **Ollama** `GET /api/ps` (size_vram, loaded) + `/api/tags` (size, details.quantization_level) — load = `POST /api/generate {model, keep_alive:-1}`, unload = `{model, keep_alive:0}`; others: none. `POST /providers/:id/models/load|unload {model}` -> `{ok:true}` or 501 `{error:"unsupported"}`; all best-effort, never throw. State is shown only when known. `effort` is added to openai-compatible entries only (dsh-bridge entries unchanged). Failures: 502 `{error}`, timeout 504 (`OMNICHAT_MODEL_ACTION_TIMEOUT_MS`, default 120 s); success broadcasts `models_changed`, and external state changes are detected by the 15 s poller.

## 9. Streaming resume
After `hello` on every WS connect the server sends `{type:"snapshot", messages:[{id, conversationId, content, status}]}` for every message of the user that is currently `streaming`, so a reconnecting/new device shows the text so far; later `delta`s continue to append to it.

## 10. WS additions summary
Client->server: `send{… parentId?, effort?, params?}`, `regenerate{…}`. Server->client: `snapshot`, `error{message, messageId?}`, `upsert` with projects/presets/settings. Close code 4001 = device revoked (client must log out).

## 11. Implementation notes (S2)
- `GET /settings` also exists (same shape as `PUT /settings`). `PUT /conversations/:id` with only `headId` does not bump `updatedAt`; invalid `headId`/`projectId`/`effort`/`systemMode` -> 400.
- Debug record: `final.params` = merged camelCase sampling params actually sent (`{}` for dsh-bridge); `response.status` = backend HTTP status (number); extra optional `response.timings`. Capped at 256 KB (raw dropped first, then message contents truncated).
- openai-compatible requests also send `stream_options:{include_usage:true}` so usage is captured.
- `regenerate`/`send` problems are reported as `{type:"error", message, messageId?}` to the requesting socket only.
