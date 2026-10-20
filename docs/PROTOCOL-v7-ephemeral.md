# PROTOCOL v7 - ephemeral chats (additive)

All additions are optional; an old client/server ignores them.

## Identity
`EPH_PREFIX = "eph_"`. Conversation id AND every message id (userMessageId, assistantMessageId) of an ephemeral chat start with `eph_`.

## Data
* `Conversation.ephemeral: boolean` (true iff id starts with `eph_`; absent on an old server).
* `Settings.ephemeralIdleMinutes: number` - integer 1..1440, default 30. `PUT /settings {ephemeralIdleMinutes}`; invalid -> 400.

## REST
* `PUT /conversations/:id` with body `{ephemeral:true, ...}` creates. Forced server-side: title "Ephemeral chat", projectId null, pinned false, mode chat. 400 if the id has no `eph_` prefix, or the prefix without `ephemeral:true` on creation; 400 for a dsh-bridge provider; 429 `Too many ephemeral chats` beyond 5 live per user. Updating a live ephemeral chat (headId, model, effort, ...) works as for normal chats. An id that is no longer live -> 410 `Ephemeral chat no longer exists` unless `ephemeral:true` is given (creation).
* `DELETE /conversations/:id` for an `eph_` id destroys it (idempotent): `200 {ok:true, ephemeral:true}`; a live chat of another user -> 404.
* `DELETE /ephemeral` destroys all live ephemeral chats of the user: `{destroyed:n}`.
* Never available for `eph_` ids (404): `GET /conversations/:id/export`, `/messages/:id/debug`, `/history/search` hits, `/sync`, stats.

## WebSocket
Server -> client:
* `{type:"ephemeral_state", conversations:Conversation[], messages:Message[], idleMinutes:number}` - sent right after `hello`/`snapshot` (also with empty arrays). Authoritative: a client removes every local `eph_` conversation (and its messages) not listed, and upserts the listed ones.
* `{type:"ephemeral_destroyed", conversationId, reason:"ended"|"idle"|"logout"|"disconnected"|"limit"}` - broadcast to all devices of the user; clients delete the conversation and its messages from memory, and leave the chat view if it is open.
* `{type:"error", code:"ephemeral_gone", message, conversationId}` when `send`/`regenerate` targets a non-live `eph_` chat (nothing is stored).
* Normal `upsert` / `delta` / `snapshot` / `phase` / `tool` frames are used for live updates. `notify` frames for these chats carry `title:"Ephemeral chat"`, `body:"Ephemeral chat finished"` (or `... failed`).

Client -> server:
* `{type:"ephemeral_end", conversationId}` - same as DELETE (usable during page unload).
* `send`/`regenerate` as usual; ids must start with `eph_` else error frame (code `ephemeral_ids`).

## Server tunables (env, mainly for tests)
`OMNICHAT_EPHEMERAL_IDLE_MS` (overrides the user setting), `OMNICHAT_EPHEMERAL_SWEEP_MS` (default 15000), `OMNICHAT_EPHEMERAL_GRACE_MS` (default 120000: creating device without a WS before destruction).
