# v0.5.5 work contract (internal)

Shared wire/message contract for the v0.5.5 betas, so workers can implement each side independently.

## Bridge frames (extension <-> server), additions

- `prompt` (E -> S): optional `searchMode?: "off" | "smart" | "always"` and `interrupt?: boolean`.
  - `searchMode` is stored on the conversation (`conversations.search_mode`), same column the app uses. Absent = keep the stored value (new conversation: inherit the user's setting, default `smart`).
  - `interrupt: true` = if a run is active in that conversation, stop it first, wait until it has ended (<= 5 s), then run this prompt.
- `conversations` items (S -> E) gain `searchMode: "off" | "smart" | "always"`.
- `context_request` (E -> S): `{ type, requestId, conversationId }`.
- `context` (S -> E): `{ type, requestId, total, limit, fits, estimated }` (numbers, booleans; `limit` may be 0 = unknown). Error reply = the existing `error` frame with the same requestId.

## Webview -> host messages (extension), additions

- `{ type: "openFile", path: string, line?: number }`: the host resolves `path` against the current workspace roots, refuses anything outside them, opens it in the editor.
- `{ type: "toggleSettings" }`: open the Settings view, or close it when it is already visible.
- `{ type: "setSearchMode", mode: "off" | "smart" | "always" }`.
- `{ type: "cancelQueued", id: string }`, `{ type: "sendInterrupt", text: string }`.

## Rules

- Strings: every user-visible string goes through `vscode-ext/src/ui/strings.ts` / `stringsChat.ts` with ja and en entries (a test checks key parity).
- Webview scripts are built from `vscode-ext/src/webview/**` to `media/webview/*.js` with `npm run build`; commit the built files.
- No inline styles in the webview (CSP): toggle classes.
- Windows: 11 `vscode-ext` tests fail from symlink privilege (files.test.ts, edit.test.ts symlink cases); ignore those.

## v0.5.5-a additions: transcript deltas and code diffs (no new top-level frame types)

Both are optional fields on existing `transcript` items, so `CHAT_FRAME_TYPES` (server) and `KNOWN_TYPES` (extension codec) need no change.

- `ready.capabilities.transcriptDelta?: boolean` (E -> S). Absent/false = the server must send full item text (old behaviour).
- Assistant item delta (S -> E, only to instances with `transcriptDelta`): `{ kind:"assistant", id, text, from?: number, reasoning?, reasoningFrom?: number, status }`.
  - `from` present: `text` is only the suffix to append, and `from` is the UTF-16 length the receiver's current text must have. `reasoningFrom` is the same for `reasoning`.
  - Receiver: if the item is unknown or `current.length !== from`, it keeps its state and requests a resync (`conversation_request`). Frames without `from` replace the text as before.
  - Server sends full text for: the first frame of an item, the final frame (status != "streaming"), and `historyItems`. Deltas only while streaming.
- Tool item diff (S -> E, any instance; old extensions ignore it): `diff?: { path: string; added: number; removed: number; truncated?: boolean; lines: string[] }`.
  - `lines[i]` starts with `+`, `-` or a space (context). Max 200 lines, each clipped to 300 chars; `truncated` when anything was cut.
  - Built by the server from the call arguments for `edit_file` (oldString/newString, common prefix/suffix lines trimmed, up to 2 context lines each side) and `write_file` (all `+`), for any approval mode, not for `denied`/`error` status. Also present in `historyItems`.

---

# v0.5.5-beta.2 additions (branch feat/v055-b): attachments, slash commands, pickers, tips

## Bridge frames (extension <-> server)

All additive. Every new E -> S type goes into `CHAT_FRAME_TYPES` (server/src/vscode-bridge.ts) AND every new type (E->S and S->E) into `KNOWN_TYPES` (vscode-ext/src/protocol/codec.ts) + `FrameType` (frames.ts). S -> E frames are validated in `isValidChatSFrame`.

- `models` items gain optional `contextLength?: number` (tokens, from the provider's model state) and `vision?: "yes" | "no" | "unknown"`.
- `devices_request` (E -> S): `{ type, requestId }`. `devices` (S -> E): `{ type, requestId, items: DeviceItem[] }`,
  `DeviceItem = { name: string; kind: "vscode" | "dsh"; online: boolean; self: boolean; workspaces: string[] }`.
  Only the user's currently online bridges; `self` = the bridge name of the asking extension. Max 50 items, 50 workspaces each.
- `compact_request` (E -> S): `{ type, requestId, conversationId }`. Answer `compacted` (S -> E): `{ type, requestId, conversationId, ok: true, before: number, after: number }` (tokens) or the existing `error` frame (same requestId; codes `not_found`, `busy`, `internal`). Uses the same function as the app's compact. Refuses while a run is active (`busy`).
- `prompt` gains `attachments?: Array<{ name: string; mime: string; data: string }>` (`data` = base64 of the file).
  - Limits (server enforces, extension/webview pre-check): max 4 files, each <= 4 MiB decoded, total <= 5 MiB decoded.
  - Documents: whatever `storeUpload` accepts (text/code/pdf/office; the existing extract limits). Audio: refused.
  - Images: png / jpeg / webp / gif only, accepted ONLY when the conversation's real model has `vision: "yes"` (same check as the app: `resolveVision`). They reach the model as image parts of that user message (newest 4 images of the history).
  - Ack failure codes: `attachment_invalid` (bad type/content/count), `attachment_too_large`, `attachment_not_supported` (image for a model without vision, or audio). Nothing is stored on a failed ack.
  - The server stores the files with the normal attachment store and passes the ids to `handleSend` as `attachmentIds`.

## Webview -> host messages, additions (validated in `parseChatMessage`)

- `send` / `sendInterrupt` gain `attachments?: Array<{ name: string; mime: string; data: string }>` (same shape and limits as the frame; the host rejects over-limit ones with the toast `attachTooBig` etc. and does not send).
- `{ type: "slash", name: "clear" | "context" | "compact" }`. `/model` and `/help` are handled inside the webview and never sent.
  - clear = start a new conversation (like `newConversation`); context = refresh the meter and answer with a toast of the usage; compact = `compact_request` for the open conversation, toast on result.
- `{ type: "requestDevices" }` -> host sends `devices_request` and puts the result into state.
- `{ type: "toggleFavorite", kind: "device" | "folder", key: string }` -> host flips it in `globalState` (keys `omnichat.fav.devices`, `omnichat.fav.folders`, string arrays).

## Host -> webview additions

- `{ type: "toast", text: string }` (already localised): shown for ~4 s above the composer.
- `ChatViewState.extras: ExtrasView` (one field, built in `src/chat/extrasModel.ts`):
  ```ts
  interface ExtrasView {
    slash: Array<{ name: "clear" | "context" | "model" | "help" | "compact"; desc: string }>; // localised
    attach: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number; imageMimes: string[]; visionOk: boolean | null };
    devices: { state: "idle" | "loading" | "ready" | "error"; items: DeviceItem[] };
    favorites: { devices: string[]; folders: string[] };
  }
  ```
  `visionOk` = vision of the effective model (null = unknown; unknown is treated as allowed, the server decides).
- `snapshot.models[*]` carries `contextLength` and `vision` (ModelItem).

## Webview rules

- Tooltips: `data-tip="text"` on any element -> shown after 2000 ms hover (also on keyboard focus after 2000 ms), hidden on leave/click/Escape. One shared `div.cm-tip` (CSSOM `style.setProperty` for position, no inline style attributes). Helper: `webview/chat/tip.ts` (`installTips(root)`, `setTip(el, text)`: sets `data-tip` and `aria-label`, removes `title` so no native tooltip doubles up).
- No innerHTML, no inline style attributes (CSP). New CSS goes into new files `media/webview/chat-input.css` (attachments, slash, toast, tip) and `chat-pop.css` (model + device/folder popovers); add both to the `styles` list in chatView.ts.
- Strings: all new keys live in `src/ui/stringsInput.ts` (ja + en, merged into `Strings`).

## File ownership (no overlap)

- Server S1 (devices/compact/models): `server/src/vscode-chat.ts` (switch + `onModels` only), `server/src/vscode-chat-extra.ts` (new), `server/src/vscode-bridge.ts` (`CHAT_FRAME_TYPES` only), their tests, `docs/API.md` (frames section).
- Server S2 (attachments): `server/src/vscode-chat-attach.ts` (new), `server/src/chat.ts`, `server/src/attachments-chat.ts`, `server/src/context.ts`, tests. Exports `prepareAttachments`; the lead wires it into `onPrompt`.
- Ext E1 (protocol + host): `src/protocol/*`, `src/chat/*` (controller*, viewModel, new `extrasModel.ts`, `slash.ts`, `favorites.ts`, `attach.ts`), `src/ui/chatView.ts` (message cases only), `src/extension.ts` only if unavoidable (must stay <= 301 lines), tests.
- Ext E2 (webview generic): `src/webview/chat/tip.ts`, `attach.ts`, `slash.ts`, `toast.ts` (new), `composer.ts`/`main.ts` (minimal hooks), `media/webview/chat-input.css`, tests for pure helpers.
- Lead (Sonnet): `src/webview/chat/modelPop.ts`, `devicePop.ts`, `pickers.ts`, `pop.ts`, `media/webview/chat-pop.css`, `src/ui/stringsInput.ts`, `strings.ts` wiring, docs/VSCODE.md, CHANGELOGs, version.

## beta.2 follow-up (queue actions, regenerate, editor chat, token breakdown)

- `context` frame (S -> E) gains optional `used?: { system, history, attachments, tools, input: number }`, `reasoning?: number`, `last?: { prompt: number; completion: number; reasoning: number }` (tokens of the latest finished assistant message; absent when none). Cache tokens are not stored by the server: the UI says "not reported".
- Webview -> host: `{ type: "interruptQueued", id }` (remove that queue entry and send its text with interrupt, same as Ctrl+Enter), `{ type: "regenerate", id }` (`id` = an assistant item id; the host re-sends the text of the user item directly before it with the current model/settings as a normal prompt; refused with a toast while a run is active), `{ type: "openInEditor" }`.
- Queue chip: x removes the chip AND writes its text back into the composer (appended after a newline when the composer already has text). The chip also gets a "run now" button (interruptQueued).
- Title marquee: pauses 1500 ms at the start and at the end before moving / returning.
- `omnichat.openChatInEditor` command opens a WebviewPanel version of the chat in the editor area (state shared with the sidebar view: both receive every post, messages from either are handled by the same handler).
- Ownership: W-A webview = `webview/chat/composer.ts`, `messages.ts`, `header.ts`, `media/webview/chat-input.css` (new rules appended); W-B host = `chat/actions.ts` (new), `ui/chatView.ts`, `ui/viewProvider.ts`, `ui/chatPanel.ts` (new), `chat/messages.ts`, `chat/viewModel.ts`, `protocol/chat-frames-v055.ts`, `package.json`+nls, `extension.ts` (<= 301 lines: move code out); W-C server = `vscode-chat.ts` onContext + tests + docs/API.md. Lead: `webview/chat/tokens.ts` after W-A.
