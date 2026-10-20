# PROTOCOL v7 - shared providers and per-user model grants (additive)

An admin can share one of their providers (for example a home LLM server or a paid API key) with other users. Shared providers are read-only for those users, and each user may use only the models the admin grants. The design and decisions are in `docs/design/SHARED-PROVIDERS.md`. This document covers the contract and the admin API. Ordinary users do not receive shared providers yet; that delivery is a later step.

## Data
* `providers.shared INTEGER NOT NULL DEFAULT 0`. Only admin-owned, non-`dsh-bridge` providers can be shared. Every provider JSON now has `shared: boolean` (the owner sees its own flag; a non-shared provider is simply `false`).
* Table `user_model_grants (user_id, provider_id, mode 'all'|'list'|'none', models JSON array, updated_at, PRIMARY KEY (user_id, provider_id))`.
* Grant rows are removed when the user is hard-deleted or the provider is deleted. Disabling a user keeps them.

## Access rule (`modelAllowed` in `server/src/shared-providers.ts`)
1. Admin -> allowed (any provider, any model).
2. Owner of the provider -> allowed.
3. Provider not shared, or deleted -> denied.
4. A grant row exists -> `all`: allowed; `list`: allowed only if the model is in `models`; `none`: denied.
5. No row -> allowed only if the server's `defaultSharedAccess` is `"all"`.

`providerUsableBy` is the same rule at provider level (is there any model at all). `listSharedProvidersFor(userId)` returns only providers that are usable, and never includes a URL, key or model:
`{ id, name, kind, shared: true, readOnly: true, allowedModels: "all" | string[] }`.

Enforcement on chat, compare, bench and `/v1` (403 `code: "model_not_allowed"`) is the next step and is not part of this contract.

## Server settings (`GET/PUT /admin/settings`)
| Key | Type | Default | Meaning |
|---|---|---|---|
| `defaultSharedAccess` | `"none"` \| `"all"` | `"none"` | access for a user with no grant row on a shared provider |
| `allowOwnProviders` | boolean | `true` | `false`: ordinary users cannot add a provider (edit and delete still work); admins always can |

Invalid values -> 400. Changes are audited (`settings.update`).

`PUT /providers/:id` for a new provider (or a soft-deleted one) by an ordinary user, while `allowOwnProviders` is false -> `403 {error:"Adding your own providers is disabled on this server"}`.

## Admin routes
All routes use `Authorization: Bearer <admin device token>` and the usual errors (`401`, `403 {error:"Admin only"}`, `400`, `404`, `429`). Mutations share the 30-per-minute admin limit. Keys and URLs are never returned.

| Route | Body | Response |
|---|---|---|
| `PUT /admin/providers/:id/shared` | `{shared: boolean}` (unknown keys -> 400) | `{id, shared}`. 404 if the provider is not the caller's own, is missing or is deleted; 400 for `dsh-bridge`. Audit `provider.shared`. |
| `GET /admin/shared-providers` | - | `{providers:[{id, name, kind, ownerUserId}]}` (not deleted) |
| `GET /admin/users/:id/grants` | - | `{defaultSharedAccess, grants:[{providerId, mode, models}]}`. 404 unknown user. |
| `PUT /admin/users/:id/grants/:providerId` | `{mode:"all"\|"list"\|"none", models?: string[]}`. `list` needs 1 to 500 distinct models, each 1 to 300 characters. `models` is stored only for `list`. | `{providerId, mode, models}`. 400 on bad input; 404 if the user is unknown or the provider is missing, deleted or not shared. Audit `grant.update`. |
| `DELETE /admin/users/:id/grants/:providerId` | - | `{ok:true, removed:boolean}` (removing the row restores the default). Audit `grant.delete` when removed. |

## Audit
Keys are `shared:<providerId>` and `grant:<userId>:<providerId>`. The values never contain a key or URL.

## Delivery and enforcement (implemented)
* **Listing.** `GET /sync` returns, in `providers`, the user's own rows (as before) plus `listSharedProvidersFor(userId)` in full on every call (not limited by `since`). A shared view is `{ id, name, kind, shared: true, readOnly: true, allowedModels, model }`. `model` is the provider's default model when it is allowed to the user, otherwise `""`. No URL, key or `hasKey`. Clients should replace their shared subset with what `/sync` returns, so a revoked provider disappears.
* **Change notice.** `{ type: "providers-changed" }` is sent to every open `/ws` (`broadcastAll`) when a provider is shared or unshared, when a shared provider is edited or deleted, when `defaultSharedAccess` changes, and to one user (`broadcast`) when that user's grant is set or removed. Clients answer by calling `/sync` again.
* **Usable rows.** `getUsableProviderRow(userId, id)` returns the user's own row or a shared row they may use, else `undefined`. It is used by chat (send, regenerate, title model), compare, bench, compact, context, `/tokenize`, `/v1`, `/providers/:id/models`, `/providers/:id/models/loaded` and `/models`. Edit, delete and key routes stay with the owner.
* **Model refusal.** The model is refused before anything is stored or sent upstream:
  * WebSocket `send`, `regenerate`, `compare` and bench: `{ type: "error", code: "model_not_allowed", message }` (no message is saved).
  * `/v1/chat/completions`: 403 `{ error: { type: "forbidden", code: "model_not_allowed", message } }`. A provider the user may not use is absent, so `/v1` answers 404 `model_not_found`.
  * Maintenance is checked first, so a maintenance refusal wins over a model refusal.
* **Other users' views.** `GET /providers/:id/models` and `/models` for a shared provider list only the allowed models. The default model is dropped when it is not allowed. Upstream error text has the URL and key replaced with `[url]` and `[key]`.
* **Load and unload** stay with the owner (404 for others). The status route for another user's shared provider returns `controllable: false`, the allowed loaded models, and no `conflict`.
* **dsh-bridge.** A shared provider cannot be `dsh-bridge`. Changing a shared provider's kind to `dsh-bridge` is refused with 400.
