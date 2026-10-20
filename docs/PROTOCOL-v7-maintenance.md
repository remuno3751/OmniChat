# PROTOCOL v7 - maintenance mode (additive)

While maintenance is enabled, **regular users cannot use the LLM**. Admins (`users.is_admin = 1`, enabled) are never blocked. Reading, searching, editing settings and logging in keep working. Optional fields are fine to leave out, and old clients ignore the new fields.

## Maintenance object
`{ enabled: boolean, message: string, eta: number | null, updatedAt: number }`
* `message`: 0..500 characters, may be empty. Empty means the server default English text is shown.
* `eta`: expected end, epoch ms, or `null`. Past times are allowed.
* `updatedAt`: epoch ms of the last change that altered `enabled`, `message` or `eta`. `0` = never changed.
* Default (never set): `{enabled:false, message:"", eta:null, updatedAt:0}`.
* Storage: table `server_settings`, key `"maintenance"`, JSON value. Code: `server/src/maintenance.ts` (imports `db.js` only).

## Endpoints
* `GET /maintenance` (no auth) -> `{ maintenance }`. Usable on the login screen.
* `PUT /admin/maintenance` (admin only, 403 otherwise; mutation rate limit; audited). Body is a partial object: `{enabled?: boolean, message?: string (<=500), eta?: null | positive integer}`. Empty body, unknown fields or invalid values -> 400 and nothing changes. Success -> 200 `{ maintenance }`. Each changed key is written to the audit log (`action "maintenance.update"`, key `enabled`/`message`/`eta`).

## Realtime
* `hello` frame gains `maintenance` (the current object).
* On every change, all open `/ws` connections of all users receive `{ "type": "maintenance", "maintenance": {...} }`. No broadcast when nothing changed.

## Blocking
Blocked for regular users only:
* WebSocket `send` and `regenerate` (including ephemeral chats): error frame `{type:"error", code:"maintenance", message, conversationId, messageId?}`. Nothing is stored and nothing is sent upstream.
* WebSocket `compare`: error frame `{type:"error", code:"maintenance", message, compareId?}`.
* `POST /bench/runs`: 503. A run already in progress stops at its next call with status `error` (fatal = the message).
* `POST /conversations/:id/compact`: 503.
* `POST /v1/chat/completions` (API key; the key owner's role decides): 503 with `Retry-After` (seconds, at least 1, only when `eta` is set).
* Automatic title generation (`autoTitle`) for a regular user: skipped.

HTTP 503 body (all of the above): `{ "error": { "type": "service_unavailable", "code": "maintenance", "message": "..." } }`.

Not blocked: a reply that is already streaming (it runs to completion, including its tool calls and quote lookup), reading or searching conversations, tokenizing (`/tokenize`), model lists, settings, login.

`message` for blocked users: the admin's text, or `"The server is under maintenance. AI features are unavailable right now."` when empty.
