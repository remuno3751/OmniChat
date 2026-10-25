# v0.5.6-d contract (VS extension 0.4.0): chat settings, effort, rename, search, JSON export

Types: `vscode-ext/src/protocol/chat-frames-v056d.ts` (authoritative). Strings: `src/ui/stringsV056d.ts`. CSS: `media/webview/chat-v056d.css` (class names below).

## Frames (all additive; each new type goes into server `CHAT_FRAME_TYPES` (E->S only) AND extension `KNOWN_TYPES` + `FrameType` (all) + `isValidChatSFrame` (S->E))
- `conversation_settings_request {requestId, conversationId}` -> `conversation_settings {requestId, conversationId, title, systemPrompt, systemMode, effort}`; failure = `error` frame with requestId (`not_found`).
- `conversation_settings_set {requestId, conversationId, systemPrompt?, systemMode?, effort?, title?}` -> `conversation_settings_ack {requestId, conversationId, ok, settings?, title?, error?, message?}`.
  Server (`server/src/vscode-chat-settings.ts`): `ownConversation` check; validate like routes-chat.ts (`sanitizeEffort`, systemMode append|replace, prompt <= 20000, title 1..200 trimmed); refused with `busy` never (settings may change during a run). Update the same columns the app's `PUT /conversations/:id` writes (`system_prompt`, `system_mode`, `effort`, `title`), bump `seq` via `nextSeq()`, broadcast `upsert` (use the existing upsertConversation helper pattern). Empty prompt string stores NULL. Error codes: `invalid_frame`, `not_found`.
- `history_search_request {requestId, query, limit?}` -> `history_search {requestId, query, results: SearchHit[]}` (<= 30). Reuse `searchHistory()` (history-search.ts); keep only hits whose conversation passes `ownConversation` for this peer (Code conversations of this bridge); if too few remain, page `searchHistory` (offset) up to 3 times. Query is trimmed, 1..200 chars else `invalid_frame` error.

## Extension host
- Controller keeps per-open-conversation `settings` (from `conversation_settings`): refetch when the conversation changes or after a set. `ChatViewState` (viewModel.ts) gains `settings: { state: "idle"|"loading"|"ready"|"error"; value: ConversationSettings | null }` and `search: { query: string; state: "idle"|"loading"|"ready"|"error"; hits: SearchHit[] }`. Each search request carries a fresh requestId; stale answers are dropped.
- Webview -> host messages (validated in parseChatMessage):
  `{type:"requestSettings"}`, `{type:"saveSettings", systemPrompt:string, systemMode:"append"|"replace", effort: EffortLevel|null}` (toast csSaved / csFailed), `{type:"setEffort", effort: EffortLevel|null}`, `{type:"searchHistory", query:string}`, `{type:"openHit", conversationId:string, messageId?:string}`.
- `{type:"slash", name, arg?: string}`: `arg` is new (<= 2000 chars). New names `effort`, `rename` (extras.slash entries with the new descs). `/export` with `arg === "json"` opens a JSON document. `/effort <level|default>`; bad/missing arg = toast effortBad. `/rename <title>`: sends `conversation_settings_set {title}`; no arg = toast renameNeedTitle.
- JSON export is built on the host from the snapshot items (no server frame): `{ title, conversationId, exportedAt, items: [{kind:"user"|"assistant"|"tool", id, text|summary, tool?, status?, at?}] }`. NO tokens/keys/cwd/device names. Pure function in `src/chat/exportJson.ts` + test. Include a timestamp only if the item has one.
- Host -> webview: `{type:"scrollToMessage", id}` after `openHit` once the conversation is loaded (best effort; ignore if the item id is absent).

## Webview DOM (CSS already written; do not add inline styles)
- Header: gear button `button.ch-iconbtn.ch-cs-open` (tip csOpen) toggles the panel. Panel `section.ch-cs[hidden]` (file `settingsPanel.ts`): `.ch-cs__head` (`h2.ch-cs__title`, close `.ch-iconbtn`), `.ch-cs__body` > `.ch-cs__field`s: `label.ch-cs__label` + `textarea.ch-cs__text` + `p.ch-cs__hint`; `.ch-cs__modes` with two `label.ch-cs__radio` (radio + text); `.ch-cs__efforts` with 5 `button.ch-cs__eff` (default, low, medium, high, max; selected one has `ch-cs__eff--on`); `.ch-cs__foot` with `button.ch-cs__btn` (cancel) and `button.ch-cs__btn.ch-cs__btn--primary` (save). Loading state shows csLoading and disables save. No conversation -> toast csNeedConversation instead of opening.
- Effort chip (`effortChip.ts`): `button.ch-pill.ch-effort-btn` in the picker bar next to the model chip, text = effort label (csEffort* ; "default" label when null; `ch-effort-btn--set` when not null), tip effortChipTip. Click opens a `.cm-pop` menu (use `pop.ts`) of the 5 levels; picking sends `setEffort`.
- History search (`historySearch.ts`): `input.ch-history__search[type=search]` above the list, debounced 250 ms, sends `searchHistory`; empty query = normal list. Results `li.ch-hit` > `button.ch-hit__btn` > `.ch-hit__top` (`span.ch-hit__title`, `span.ch-hit__tag` = searchMessageHit/searchTitleHit) + `span.ch-hit__snippet` (match markers: the server snippet wraps each match in \u0001 … \u0002; split on those and render matches with createElement `mark`, NEVER innerHTML). Click -> `openHit`, drawer closes. States: searchSearching / searchNone / searchFailed as `p.ch-history__note`.
- Scroll target gets class `ch-msg--flash` for 2 s (remove on animationend or timeout).

## File ownership
- W1 server: `server/src/vscode-chat-settings.ts` (new), `server/src/vscode-chat.ts` (import + 3 switch lines only), `server/src/vscode-bridge.ts` (`CHAT_FRAME_TYPES` only), `server/src/vscode-chat-settings.test.ts`, `docs/API.md`.
- W2 host: `vscode-ext/src/protocol/{codec,frames}.ts` (+ validators; put validators in a new `chat-validate-v056d.ts` if codec is near its limit), `src/chat/**` except checkpoints*, `src/ui/chatView.ts` (message cases only), `src/ui/extrasModel`/`chat/extrasModel.ts`, tests, `docs/VSCODE.md`, package.json/CHANGELOG/version (0.4.0, incl. tests that pin the version).
- W3 webview: `vscode-ext/src/webview/chat/**` (new files settingsPanel.ts, effortChip.ts, historySearch.ts; minimal hooks in main.ts, header.ts, history.ts, pickers.ts, slash.ts, messages.ts, types.ts), `media/webview/chat.js` via `npm run build`.


## Amendment: effort levels are off|low|medium|high|max (same as the app's picker); 6 steps incl. default (null).
