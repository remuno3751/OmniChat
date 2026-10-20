# PROTOCOL v7 - model load policy (chat only)

Problem: a local LLM server (LM Studio, Ollama) already has model A loaded; the user chats with model B; the server JIT-loads B next to A and exhausts VRAM/RAM.
Fix: before a chat turn can cause a load, the OmniChat server checks the loaded state of the provider and, when another model is loaded, refuses the turn with a typed error until the client states a policy.

Scope: **chat conversations only** (`conversation.mode === "chat"`, provider kind `openai-compatible`). Code-mode conversations, `dsh-bridge` providers, compare and bench are never gated and behave as before.
Backends: any server with a detected adapter that has both `load` and `unload` capability (LM Studio >= 0.4 REST `/api/v1`, Ollama `/api/ps` + keep_alive). llama.cpp (one model per process), old LM Studio without `/api/v1`, generic servers, unreachable servers: no control, no dialog, nothing changes.

## Wire protocol

### Client -> server (`send` and `regenerate` frames, both optional)

```
loadPolicy?: "unload_then_load" | "use_loaded" | "load_both"
useModel?:   string   // only with use_loaded: which loaded model id to switch to (default: the first loaded one)
```
An invalid value is ignored (treated as absent). The policy is only consulted when there is a conflict; the client may attach a remembered policy to every send.

### Conflict definition

`conflict` exists when: chat mode, openai-compatible, adapter with load+unload, the effective model (`conversation.model || provider.model`) is known to the backend and NOT loaded, and at least one other *chat* model (embedding/rerank ids excluded via `NON_CHAT_RE`) is loaded.

### Server -> client

1. Conflict, no usable policy. Nothing is persisted, nothing is loaded or unloaded:
```
{ type:"error", code:"model_conflict", message, conversationId, messageId /* assistantMessageId */, conflict: ModelConflict }
```
2. Policy applied but unload/load failed (nothing persisted; the client re-opens the dialog with the error, options unchanged):
```
{ type:"error", code:"model_load_failed", message, conversationId, messageId, conflict: ModelConflict }
```
3. Progress, while a policy is executed or the LM Studio no-conflict preload runs (before the message is stored):
```
{ type:"model_load", conversationId, messageId, providerId, phase:"unloading"|"loading"|"ready", model /* target */, unloading?: string[] /* ids being unloaded */ }
```
`ready` is sent once the target is verified loaded; then the turn proceeds normally (user + assistant message upserts follow).

```
ModelConflict = {
  providerId, providerName, kind /* "lmstudio" | "ollama" */,
  model, modelSizeBytes?,
  loaded: [{ id, sizeBytes?, vramBytes? }]      // all other loaded chat models, sorted by id
}
```

### REST

`GET /providers/:id/models/loaded?model=<id>` (auth) ->
`{ controllable: boolean, kind?: string, loaded: [{id,sizeBytes?,vramBytes?}] /* every loaded chat model */, targetLoaded: boolean | null, conflict: ModelConflict | null }`
(`controllable:false` -> loaded `[]`, conflict `null`.) Existing `POST /providers/:id/models/load|unload` are unchanged.

## Policies (server side, executed under a per-backend lock)

| policy | effect |
|---|---|
| none / conflict | reply `model_conflict`, stop |
| `unload_then_load` | `model_load{unloading}`; unload every other loaded chat model; verify; `model_load{loading}`; load target (`defaultContextLength` setting honored); verify loaded; `model_load{ready}`; continue |
| `use_loaded` | set `conversation.model` to `useModel` (must be in the loaded list, else the first loaded) and broadcast the conversation upsert; continue with it. Nothing is loaded |
| `load_both` | explicit load of the target without unloading; continue |

Failure of any step: `model_load_failed` (see above). If after a failed load the target is reported loaded anyway (e.g. the backend JIT-loaded it meanwhile), it counts as success. A target that became loaded while we waited for the lock needs no load.

Serialization: the check, the unload and the load run under one in-process lock per backend origin (`originOf(provider.base_url)`), so two chats sending at once cannot both observe "nothing loaded" and both load. For `lmstudio` the lock holder also loads the target explicitly (best effort: a failed preload with no conflict falls back to the backend's own JIT) so that the second chat sees the first model as loaded and gets the conflict. Other backends (Ollama) are not preloaded without a conflict. The lock is held only during preparation, not during token generation.

Timeouts: unload/load use `OMNICHAT_MODEL_ACTION_TIMEOUT_MS` (default 120 s) -> `model_load_failed` message "timeout"; state verification polls up to `OMNICHAT_MODEL_VERIFY_MS` (default 8000).

## Client (app)

* Device setting `modelLoadPolicy: "ask" | "unload_then_load" | "use_loaded" | "load_both"` (default `ask`, per device, never synced). Cancel is never stored. Settings > Chat shows it with a reset to `ask`.
* `decideConflict(remembered, conflict)` (pure, `app/src/modelLoad.ts`): remembered != ask -> send with that policy; otherwise show the modal.
* Modal (themed `Sheet`): the four choices, 1 = primary + "Recommended" badge + initial focus; model names and sizes (when known), loaded ids; "Remember my choice" checkbox (ignored for Cancel); `load_both` shows a one-line memory warning; when re-opened after `model_load_failed` the error text is shown.
* Cancel: nothing sent, draft restored. Others: the same request is re-sent with `loadPolicy` (new ids are not needed: nothing was persisted).
* Progress: `model_load` frames drive a status line above the composer: "Unloading X..." / "Loading Y...".

## Not covered

A turn that was already admitted keeps streaming from its model: if a second chat then unloads that model (its own explicit choice), the first stream can fail or the backend may JIT-reload it (the lock is not held during generation).

External clients that use the backend directly, compare/bench runs (they intentionally use several models), models loaded by someone else between our check and the backend's own JIT (small window; an explicit preload under the lock closes it for LM Studio).
