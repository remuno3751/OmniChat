# BRIDGE v2 — model selection + two-way session sync (extends BRIDGE.md; read that first)

## A. Model selection

### modelRef
A model on a dsh bridge is addressed as `modelRef = "<provider>::<id>"`, e.g. `opencodex::lm-studio/lfm2.5-24b-a2b` (ids may contain `/`). `conversations.model` stores it for dsh-bridge conversations. For `openai-compatible` providers `conversations.model` is just the model id as before. `null` / empty / `"dsh"` = the bridge's default model.

### Bridge side
- Model discovery: the bridge reads the **model lists only** (`provider`, `id`, `name`) of the `llm-pi-ai` entry from the dsh profile it runs (`~/.dsh/profiles/<profile>/cordis.patch.yml`, parsed with the `yaml` package; fall back to the default-model overlay's model if nothing is found). It must NEVER read `~/.dsh/.credentials.yaml`, and must never log or transmit `headers`, apiKeys, tokens, or baseURLs. Re-read the file when its mtime changes and send `models` again.
- `ready` gains `models?: {provider:string, id:string, name:string}[]` and `defaultModel?: string` (modelRef, from the overlay file if known).
- New bridge->server frame `{type:"models", models:[...], defaultModel?}` whenever the list changes.
- `run` gains `model?: string|null` (modelRef). If set, the bridge writes a per-run temp overlay (OS temp dir, deleted afterwards) with an `agent-default-model` entry `{provider, model:id}` and passes it as a `--patch` flag AFTER the user's `--dsh-patch` (multiple `--patch` flags are allowed; later wins). A bare id without `::` uses the default provider.

### Server side
- `GET /providers/:id/models` -> `{models:[{id,name}], error?}`. openai-compatible: `GET {baseUrl}/models` with the key (5 s timeout, 60 s cache, `error` text on failure, never throws). dsh-bridge: what the named bridge last reported (`id` = modelRef, `name` = `<id> (<provider>)`), `[]` if offline.
- `GET /models` -> `{groups:[{providerId, providerName, kind, models:[{id,name}], error?}]}` over all the user's non-deleted providers (parallel fetch).
- dsh-bridge provider passes `req.model` as `run.model` when it contains `::`; otherwise omits it.

### App side (Claude-style model picker)
Chat-header button shows the current model name and opens a popover/sheet listing groups (provider name) with models, a checkmark on the current one, a filter box when there are many, a refresh button, and a "Custom model id…" row. Selecting PUTs `{providerId, model}` on the conversation. New chats start with the last selection (persisted per user in AsyncStorage). It replaces the existing provider/model chooser in ChatScreen.

## B. Two-way sync with DeepSeek Harness's own UI

dsh persists every session (GUI and headless alike) at `~/.dsh/sessions/<cwd-slug>/session-<uuid>/session.v4.jsonl.zstd`. The bridge **mirrors** those logs to the server; runs started from the app already land in the same logs, so the dsh GUI shows them too when the bridge `--cwd` equals the GUI workspace.

### Log format (verified, "v4", internal, may change — fail soft)
Append-only file of independently zstd-compressed frames (magic `28 B5 2F FD`). `zlib.zstdDecompressSync` over the whole file returns only the first frame, so split at the magic bytes, decode each frame, concatenate -> JSONL. A frame may be incomplete while dsh is writing: ignore frames that fail to decode and retry next poll. Records have `seq`, `time` (epoch ms), `type`, `data`:
- `{"type":"session","id":"session-<uuid>","createdAt":..,"cwd":"..."}` first line.
- `turn/start` `{data:{turn:N}}`, `turn/end` `{data:{turn:N,reason:{kind:"completed"|"error"|...}}}`.
- `user/message` `{data:{content:[{type:"text",text}],source:{kind:"user"},role:"user",id}}` — ONLY those with `data.source.kind==="user"` are human messages; other `user/message` records are injected system context: ignore. `agent/inbox/spliced` is not a message: ignore.
- `assistant/message` `{data:{turn,step,message:{role:"assistant",content:[{type:"reasoning"|"text"|"tool-call",...}]}}}` — keep only `type:"text"` parts.
- `tool/call` `{data:{turn,step,callId,name,arguments:"<json string>"}}`; `tool/result` `{data:{turn,step,message:{content:[{type:"text",text}]}}}` (failure if text starts with "Error").
- `session/title` `{data:{title}}` (last wins).

### Mirror frames (bridge -> server)
`{type:"sessions", full:boolean, sessions:[{sessionId, cwd, title:string|null, updatedAt:number, messages:[{key, role:"user"|"assistant", text, createdAt, status}]}]}`
- `key`: user messages `u:<turn>:<k>` (k = index of that human message within the turn); assistant messages `a:<turn>` = ONE message per turn: in order, the text parts of every step plus tool calls rendered with the same markdown as the live provider (`\n\n> 🔧 <name> <short json args, <=120 chars>\n\n`; failed results `> ⚠️ <name> failed: <first 120 chars>\n\n`). Assistant `status`: `"streaming"` while the turn has no `turn/end`, then `"done"` (completed) / `"error"` / `"stopped"`; user messages are always `"done"`. `createdAt` = log `time` of the message's first record.
- After (re)connect send `full:true` with the 30 most recently modified sessions (only sessions whose cwd equals the bridge `--cwd`, unless `--mirror-all`), full messages (cap 300 per session, keep newest). Then `full:false` deltas: only sessions/messages whose text or status changed since last sent, polling each file every 1.5 s by (mtime,size) with per-file incremental state (frame offset) so only new frames are decoded; new session files are picked up automatically. Skip sessions with no human message.
- Flags: `--no-mirror` (mirroring is on by default), `--mirror-all`, `--dsh-home` (default `~/.dsh`).

### Server handling
- Table `mirror_map(user_id, bridge_name, session_id, key, message_id, origin)` PK (user_id, session_id, key); `origin` = `'app'|'dsh'`.
- Conversation for a session: via `agent_sessions.session_id`; if unknown, create conversation `id = "dsh-" + sessionId`, title = session title, else first user text (40 chars), else "dsh session"; `providerId` = the user's first non-deleted `dsh-bridge` provider whose `baseUrl` equals the bridge name (else null); insert the `agent_sessions` row; broadcast upserts.
- For each mirrored message: mapped and origin `'app'` -> skip; mapped and origin `'dsh'` -> update content/status if changed; unmapped -> create message (new uuid, `createdAt` from the log, role/content/status from the frame), map with origin `'dsh'`, broadcast.
- Linking app-originated runs: while a run is active for a conversation, on `status{phase:"turn_start",turn:N}` events record `u:N:0` -> the user message id and `a:N` -> the assistant message id in `mirror_map` with origin `'app'`. Mirror frames for a session are ignored while a server run for that session is active (idempotent afterwards thanks to the mapping).
- When a bridge disconnects, its origin-`'dsh'` messages still `streaming` become `error`.
- The app orders messages by `createdAt` (verify; fix in app if it orders differently).

### Caveats (document in README)
- App and dsh GUI must not run a turn in the same session at the same moment (two writers). The bridge refuses a `run` (`done ok:false error:"session busy in dsh"`) when that session's log changed in the last 3 s and no run of ours is active for it.
- The log format is dsh-internal; on a parse failure mirroring disables itself with one stderr warning while chat via the bridge keeps working.

## C. Preview file access (fs)

Read-only access to files in the bridge's working folder, for the Code preview (design: `docs/design/CODE-PREVIEW.md`, stage 2). The bridge is the last gate: it enforces every rule below, whatever the server sends. Default **OFF**.

### Frames
- Bridge -> server: `ready` carries `capabilities: { fs: true }` **only when enabled**. When disabled the frame is exactly as before (no `capabilities` key). `ready` is sent on every connection, so reconnects re-advertise.
- Server -> bridge: `{ type: "fs", requestId, cwd, op: "list" | "read", path: string, maxBytes?: number }`
- Bridge -> server: `{ type: "fs_result", requestId, ok, error?, entries?: [{ name, kind: "file" | "dir", size }], content? /* base64 */, size?, mime?, truncated? }`

### Enabling
- Daemon bridge: `--allow-preview-fs`. Plugin (remote mode): config `previewFs: true`, or env `OMNICHAT_BRIDGE_PREVIEW_FS=1` when the key is not set.
- When disabled, every `fs` request gets `{ ok: false, error: "preview is disabled on this bridge" }`.
- Why off by default: the server's administrator could otherwise read files under the workspace of any bridge pointed at that server. Enable it only for a folder you accept to share with that server.

### Rules
- `cwd` must be the bridge's working folder (daemon: same as `--cwd`; plugin: a known working directory, as for `rewind`), else `cwd does not match the bridge working directory` / `cwd is not a known working directory`.
- Works while a run is in progress (read only).
- Paths are relative, `/` or `\` separators. Refused: `..`, absolute paths, drive letters, UNC, `\\?\`, NUL, `:` (alternate streams), reserved device names (CON, NUL, COM1 ...), trailing dots or spaces.
- Symlinks and junctions are followed only while the real location stays inside the folder. The real path is checked again after the file is opened (TOCTOU guard: the opened file must be the one checked).
- Never listed or read: segments starting with `.` (hidden, `.git`, `.env*`), `node_modules`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.env`, `id_rsa*`, `id_ed25519*`, and names containing `credential` or `secret`.
- `read`: regular files only, extension allow list (html htm css js mjs json svg txt md csv xml png jpg jpeg gif webp ico woff woff2 ttf otf mp3 wav ogg mp4 webm); `mime` from the extension. Limit 3 MB; `maxBytes` can lower it, never raise it. Over the limit: the head is returned with `truncated: true`.
- `list`: at most 2000 entries, directories first, then by name; `truncated: true` when there are more. Hidden, denied and `node_modules` entries are omitted.
- Rate: 20 requests per second and 4 at once; beyond that `too many requests`.
- Errors never contain the full path. Logs record the relative path and the result type only, never content.

## D. Workspaces (plugin 0.9.0, additive; docs/design/CODE-WORKSPACES.md)

Lets the Code tab group conversations by working folder and start a new chat in a chosen folder. Old plugins / servers ignore every field below.

- Bridge -> server `ready`: `capabilities.workspaces: true`, `workspaces: string[]` (known working folders, most recent first, at most 50: the configured `cwd`, folders of mirrored GUI sessions, folders of earlier runs) and `allowAnyCwd: boolean`.
- Bridge -> server `{type:"workspaces", workspaces:[...], allowAnyCwd}`: sent when the list changes (after a mirror snapshot / delta or a run).
- Bridge -> server run event `{type:"session", sessionId, cwd}`: `cwd` is the folder the session really uses (before 0.9.0 it was the configured `cwd` only). The server stores it on the conversation. The mirror `sessions` frame's per-session `cwd` is stored too (it also backfills conversations created before the column existed).
- Server -> bridge `run`: optional `cwd` for a NEW session (`sessionId` null) of a bridge that sent `capabilities.workspaces`. Ignored when resuming a session.
- App -> server `send`: optional `cwd` on the first message of a Code chat. The server checks the format, then (bridge online, workspaces supported, not `allowAnyCwd`) that it is one of the bridge's workspaces; error code `invalid_cwd` otherwise. It is stored on the conversation and forwarded in `run`.
- `GET /bridges`: each bridge also has `workspacesSupported`, `workspaces`, `allowAnyCwd`. Conversation JSON has `cwd: string | null`.

### cwd rules (the plugin decides; the server checks too)

1. Always refused: not a string, empty, over 1000 characters, NUL or other control characters (0x00-0x1f, 0x7f), relative paths, any `..` segment. Only absolute POSIX (`/x`), drive (`C:\x`, `C:/x`) and UNC (`\\host\x`) paths pass the shape check.
2. Then the folder must equal (after normalisation: `\` -> `/`, no trailing `/`, case-insensitive for Windows-style paths) one of the bridge's known workspaces. A prefix or parent is not enough.
3. Config `allowAnyCwd: true` (default `false`) skips rule 2 only. Use it only on a PC where everyone who can use this OmniChat account may start sessions anywhere.
4. A refused run ends with `done {ok:false, error:"cwd not allowed"}`; no session is created.
