# PROTOCOL v7 - dsh models (additive)

Two features share this document. All additions are optional: an old plugin, server or client ignores them.

1. **Code tab model picker = the models of the connected PC's dsh.** The bridge reports its dsh model catalog (with provider display names and the dsh default); the server relays it; the Code tab picker shows exactly those models.
2. **Import OmniChat models into dsh.** The dsh plugin asks the paired OmniChat server (over the existing authenticated bridge link) for its models and registers them in dsh as an OpenAI-compatible provider.

Frames travel on the existing `/bridge` WebSocket (server <-> bridge). In local plugin mode the OmniChat app relays them opaquely, so nothing in the relay changes.

## 1. dsh models in the Code tab

### 1.1 Bridge -> server (`ready` and `models` frames)

`models[]` entries (existing: `provider`, `id`, `name`) gain two optional fields:

```
{ provider: "lmstudio", id: "qwen3-8b", name: "Qwen3 8B",
  providerName?: "LM Studio",   // display name of the dsh provider group (dsh modelCatalog().groups[].name), <= 100 chars
  imported?: true }             // the entry comes from the "omnichat" provider created by feature 2
```

`defaultModel` (`"<provider>::<id>"`, existing) is the model the dsh GUI currently has selected. The set is refreshed on `models` frames (existing triggers: dsh adapter/settings change events and a 30 s poll), so an import shows up without reconnecting.

Selecting a model: the conversation stores `model = "<provider>::<id>"` (unchanged). Every `run` frame carries it; the plugin applies it to the dsh session with `sessionController.selectModel({sessionId, provider, model})` (the dsh session-local API; the GUI default is restored afterwards, see dsh-plugin/README.md). No new frame is needed.

### 1.2 Server -> clients (`GET /models`, `GroupModels`)

For a `dsh-bridge` provider the group's `models[]` entries are `ModelEntry`:

```
{ id: "<provider>::<id>", name, group?: string, current?: boolean, imported?: boolean }
```

* `group` = bridge `providerName` (else the provider id); absent for old plugins.
* `name` = the bridge display name when `providerName` is present; for old plugins unchanged (`"<id> (<provider>)"`).
* `current` = true for the entry equal to the bridge `defaultModel`.
* `imported` = the bridge `imported` flag.
* The group-level `defaultModel` (existing) stays.

### 1.3 Client (Code tab picker)

`ModelPicker` with `codeMode` shows only `dsh-bridge` groups: the group of the conversation's bridge provider, or every bridge group when the selection is not a bridge. Models are sub-grouped by `group` (title "<bridge> · <dsh provider>"); `current` is marked "DSH current", `imported` "OmniChat". If no bridge group has any model (old plugin, dsh unreachable, bridge offline) the picker falls back to the full list and shows a note. Chat-tab pickers are unchanged.

## 2. Import OmniChat models into dsh

### 2.1 Frames

Plugin -> server (all carry a `requestId` string chosen by the plugin, <= 100 chars):

| frame | meaning |
|---|---|
| `{type:"omni_models_request", requestId}` | list the models the server's `/v1/models` offers this user |
| `{type:"omni_key_request", requestId}` | mint a per-device API key for the `/v1` endpoint |
| `{type:"omni_key_revoke", requestId, keyId}` | revoke a key minted earlier |

Server -> plugin (answered on the same bridge socket; every reply echoes `requestId`):

```
{type:"omni_models", requestId, ok:true, baseUrl:"https://host/v1",
 models:[{id:"lm-studio/qwen3-8b", name:"qwen3-8b", providerName:"LM Studio", contextWindow?:32768}]}
{type:"omni_key", requestId, ok:true, keyId:"<uuid>", apiKey:"ocsk-..."}      // the key is shown exactly once
{type:"omni_key_revoked", requestId, ok:true}
// any failure:  {type:"omni_models"|"omni_key"|"omni_key_revoked", requestId, ok:false, error:"<short message>"}
```

* `models[].id` is the id to use against `/v1` (`<provider slug>/<model id>`, same as `GET /v1/models`). Only models of `openai-compatible` providers, chat models only (embedding/rerank etc. are excluded), at most 500, sorted by id. `name` is the plain model id part; `providerName` is the provider's display name; `contextWindow` is present only when known (loaded/declared context length).
* `baseUrl` is the `/v1` endpoint a client on the PC can reach: `OMNICHAT_PUBLIC_URL` (env) if set, else derived from the bridge upgrade request (`x-forwarded-proto`/`host` headers, falling back to the socket), with `/v1` appended.
* Keys are ordinary API keys (`ocsk-...`, see `POST /apikeys`) named `DSH import (<bridge name>)`; they appear in Settings -> API keys and can be revoked there. `omni_key_revoke` only revokes keys of the same user whose name starts with `DSH import`. At most 5 `omni_key_request`s per bridge connection per minute (reply `ok:false, error:"rate limited"`).
* A request that cannot be answered within 15 s is treated by the plugin as failed (`omni-timeout`).
* The key never appears in any log, in `omnichat-imported-models.json`, or in the plugin's settings-page state.

### 2.2 How models are registered in dsh (decision)

dsh keeps providers for the OpenAI-style routes in the `llm-pi-ai` plugin entry (`providers.<id>: {displayName, api, baseURL, apiKeyEnv, models[]}`), persisted by dsh itself in the profile's `cordis.patch.yml`. The `llm-pi-ai` adapter and the Models settings page change this config at runtime through the dsh `settings` service (`settings.update / mutate`, "applies: live"), and credentials through the `credentials` service (`credentials.set(ref, value)`, stored in `<DSH_HOME>/.credentials.yaml`, never in the patch file). The plugin uses exactly these two services (`ctx.get('settings')`, `ctx.get('credentials')`):

* provider id `omnichat`, `displayName: "OmniChat"`, `api: "openai-completions"`, `baseURL: <baseUrl>`, `apiKeyEnv: "OMNICHAT_API_KEY"`, `models: [{id: "<slug>/<model>", name: "[OmniChat] <model>", input: ["text"], contextWindow?}]`;
* the API key: `credentials.set("OMNICHAT_API_KEY", apiKey)`. If the credentials service is unavailable or refuses (a read-only source shadows the name), the import fails with `omnichatbridge/omni-credentials-unavailable`; the key is never written into `headers`.
* no restart is required (live). If the `settings` service is missing or rejects the write the import fails with `omnichatbridge/omni-settings-unavailable` and `details.snippet` carries the YAML to paste into `cordis.patch.yml` manually (without any key).

Recognizable as coming from OmniChat in the dsh model list: provider `OmniChat` (its own group), model names prefixed `[OmniChat] `, and bridge flag `imported:true` (shown in the OmniChat Code picker).

### 2.3 Record file

`<DSH_HOME>/omnichat-imported-models.json` (written atomically via temp file + rename, mode 0600 where supported, **no secrets**):

```
{ "version": 1, "providerId": "omnichat", "baseUrl": "https://host/v1", "keyRef": "OMNICHAT_API_KEY", "keyId": "<uuid>|null",
  "importedAt": 1760000000000, "syncedAt": 1760000000000,
  "models": [ { "id": "lm-studio/qwen3-8b", "name": "[OmniChat] qwen3-8b", "providerName": "LM Studio" } ] }
```

### 2.4 Settings-page remote methods (`omnichatbridge` namespace)

All four take **one** json parameter named `args` and return one JSON object. Business failures throw `RemoteError`.

| method | args | result |
|---|---|---|
| `omniModels` | `{}` | `OmniState` (never throws for transport problems: `ok:false` + `errorCode`) |
| `omniImport` | `{ids: string[], baseUrl?: string}` | `OmniState` after the import (additive: existing imports stay) |
| `omniSync` | `{addNew?: boolean}` (default true) | `OmniState & {diff:{added,updated,removed}}`: updates names/context, removes imported models the server no longer lists, adds new ones when `addNew` |
| `omniRemove` | `{all?: true, ids?: string[]}` | `OmniState`; `all` removes the provider, the credential, revokes the key (best effort) and deletes the record |

```
OmniState = {
  ok: boolean, errorCode?: string, error?: string,          // errorCode: omni-not-connected | omni-timeout | omni-server-error | omni-bad-reply
  linked: boolean,                                          // the bridge currently has a live link to the OmniChat server
  providerId: "omnichat", baseUrl: string|null,
  available: [{id, name, providerName, contextWindow?, imported: boolean}],   // from the server; [] when ok:false
  imported:  [{id, name, providerName?, stale: boolean}],   // from the record; stale = no longer offered by the server
  syncedAt: number|null
}
```

RemoteError codes: `omnichatbridge/omni-not-connected`, `omni-timeout`, `omni-server-error`, `omni-settings-unavailable`, `omni-credentials-unavailable`, `omni-bad-args`, `omni-failed`.
