# Ephemeral chat ("消えるチャット")

A conversation that leaves **no history**: meant for confidential work (e.g. drafting emails). Chat tab only; the Code tab does not offer it (dsh-bridge providers are refused).

## Design (and why)

**Server store.** Ephemeral rows live in a second SQLite database, `ATTACH ':memory:' AS eph`, on the *same* connection, with the same schema as the on-disk tables `conversations`, `messages`, `metrics`, `checkpoints`, `agent_sessions` (DDL is copied from `sqlite_master`, FTS tables/triggers are NOT copied). `db.ts` exports a routing `db`: inside an `AsyncLocalStorage` scope (`runEphemeral`) - or when any bound argument is a string starting with `eph_` - SQL naming those tables is rewritten to `eph.<table>`. Everything else (providers, settings, users) still hits the real DB. This lets generation, streaming, branching/regenerate, tools and metrics reuse the normal code path unchanged, while every row of an ephemeral chat is physically in RAM: it is never in the DB file, the WAL, FTS, backups (`VACUUM INTO` copies only `main`), export, history search or stats (those queries read `main`). `PRAGMA temp_store=MEMORY` and `eph.secure_delete=ON` keep sorter spill files and freed pages out of the picture.

**Identity.** Conversation ids and the message ids of an ephemeral chat start with `eph_`; the server refuses to create such an id without `ephemeral:true` and refuses `ephemeral:true` without the prefix, so a normal chat can never be routed to RAM by mistake and an ephemeral write can never fall through to disk (it would be routed to `eph` by its ids).

**Lifetime.** Destroyed (rows deleted, `ephemeral_destroyed` frame broadcast, running generation aborted) when: the user ends it (`DELETE /conversations/:id` or WS `ephemeral_end`, also fired when the client leaves the chat); idle for `ephemeralIdleMinutes` (default 30, 1-1440, per-user server setting); the creating device logs out / is revoked; the creating device has no open WebSocket for 2 minutes; or the server restarts (memory only). Max 5 live per user.

**Side channels closed.** Title is fixed "Ephemeral chat" (no title-generation call, no title persistence); no pin/project; no debug record (`saveDebug` skipped); notifications are generic ("Ephemeral chat finished", no title/body, also for ntfy); no content in the log ring (server logs only counts/timings); compare/bench are not reachable for these ids; context compression is computed per request and never stored. Other devices see the chat live over WS while it exists and drop it on `ephemeral_destroyed`/`ephemeral_state`; the REST `/sync` never contains it.

**Client.** Ephemeral conversations/messages are excluded from the AsyncStorage offline cache, composer drafts for them are memory-only, they are hidden from the chat list/search/history and removed from memory on destruction.

## Guarantees

* No ephemeral message text, reasoning, tool output or title is written to the SQLite file, `-wal`/`-shm`, backups, exports, FTS, debug records, logs, notifications or the client's persistent storage.
* The chat is gone from server RAM after any of the events above.

## NOT guaranteed (residual traces)

* **The LLM provider.** LM Studio / llama.cpp / a remote API (OpenAI-compatible or otherwise) receives the full prompt and may log or retain it. The client warns when the provider is not loopback/LAN.
* Process memory is not zeroed: a memory dump or swap file of the server process may still hold text after destruction (until overwritten).
* Browser/OS: clipboard, screenshots, OS keyboard history, web-view caches, copy-pasted text, and anything the user copies out. Tool results fetched from the web (web_search) are sent to the search backend. Files produced by artifact/Office export features are outside this guarantee.
* A compromised server or a user with admin access to the running process can read live chats. Network transport protection is the same as for normal chats.
* After a crash, a client that still shows the chat keeps it in its memory until it reconnects (`ephemeral_state` then clears it).
