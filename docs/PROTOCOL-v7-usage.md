# PROTOCOL v7 - usage analytics and slash commands (additive)

All additions are optional; an old client/server ignores them. Everything is per user and needs auth.

## Usage endpoints (read-only)
Source: the `metrics` table (one row per finished assistant reply). `totalTokens = prompt + completion`; reasoning tokens are a SUBSET of completion tokens (chart: input = prompt, thinking = reasoning, output = completion - reasoning). A row with `usage_exact = 0` is an estimate; every response carries `estimated: boolean` (any estimated row) and per-group `estimatedMessages`.

Common query params: `from`/`to` epoch ms (from inclusive, to exclusive, invalid values ignored), `tz` minutes EAST of UTC (JS `-getTimezoneOffset()`, clamped to +-840, default 0), `scope=all` (admin only, else 403; default = the caller's rows). Ephemeral chats (`eph_` ids) are never counted, ranked or titled (they live in the in-memory store; an explicit SQL guard also excludes them). Deleted chats still count in summary/daily/models but are not listed in `/usage/chats`.

* `GET /usage/summary?from&to&tz&conversationId` -> `{from,to,tz,totals:{promptTokens,completionTokens,reasoningTokens,totalTokens,messages,chats,avgTokensPerAnswer,estimatedMessages},estimated,topModel:{providerId,providerName,model,totalTokens}|null}`. `conversationId` restricts to one of the caller's chats (404 otherwise, always 404 for `eph_`).
* `GET /usage/daily?days=N&tz` (N 1..3660, default 30, 0 = all, else 400) -> `{tz,days:[{day:"YYYY-MM-DD",start,promptTokens,completionTokens,reasoningTokens,totalTokens,messages,estimatedMessages}],estimated}`: exactly N zero-filled local-day buckets ending today (pure offset arithmetic, independent of the server timezone).
* `GET /usage/chats?from&to&limit` (limit 1..200, default 20) -> `{chats:[{conversationId,title,models[<=3],promptTokens,completionTokens,reasoningTokens,totalTokens,messages,estimatedMessages,lastActivity}],estimated}` ordered by totalTokens desc.
* `GET /usage/models?from&to` -> `{models:[{providerId,providerName,providerKind,model,...tokens,messages,estimatedMessages,share(0..1)}],estimated}`.
Index: `metrics_user_conv (user_id, conversation_id)` (idempotent migration). All queries are single GROUP BY statements.

## Manual compaction
`POST /conversations/:id/compact` body `{instructions?: string (<=2000), keepTurns?: 0..20 (default 2)}`.
* 200 `{ok:true,compacted:true,tokensBefore,tokensAfter,summarizedMessages,keptMessages,summaryTokens,estimated}` or `{ok:true,compacted:false,reason:"too_short"}`.
* Errors: 400 bad body / code chat / provider cannot summarize, 404, 409 `A reply is being generated`, 410 ephemeral chat gone, 502 `Summarization failed` (nothing stored).
* Semantics: the active branch is summarized except the last `keepTurns` user turns (and what follows); a previous summary is folded in (`Previous summary:`); `instructions` is appended to the summarizer prompt. The summary is STORED (`conversations.compact_summary / compact_upto / compact_at`) and `buildContext` uses it on later turns (summary appended to the system message under `[Summary of the earlier conversation]`, covered messages dropped from the request). Messages are never deleted or changed; branching to a path that does not contain `compact_upto` ignores the summary. Ephemeral chats may compact (the columns live in the in-memory store). Uses the chat's own provider/model through the plain `/chat/completions` call, like auto-compression (no model-load gate).
* `GET /conversations/:id/context` gains `summaryTokens` (already included in `used.system`).
* Not synced to other devices (no `seq` bump); the server context is authoritative.

## Slash commands (client, chat tab)
Parsed by `parseSlashCommand` (app/src/slashCommands.ts); a recognized command is never sent to the model, results are local non-persisted cards. Unknown `/xxx` is sent as text as before.
`/compact [focus]`, `/context`, `/usage [today|week|month|all]`, `/clear` (= /new but carries model, search mode, effort), `/help`, `/rename <title>`, `/model [name]` (fuzzy; no arg opens the picker), `/effort <low|medium|high|max|default>`, `/export [md|json]`, `/pin`, `/unpin`, `/retry`.
Hidden in the Code tab: compact, context, effort. Hidden in ephemeral chats: rename, export, pin, unpin, usage. Commands needing a saved chat answer "Send a message first" in a draft.
