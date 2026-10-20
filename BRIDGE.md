# DeepSeek Harness (dsh) bridge — design & wire contract

Goal: chat from phone/PC (OmniChat) with the DeepSeek Harness agent running on the user's PC, with no inbound port opened on the PC. The PC runs a small **bridge** daemon that connects *outbound* to the OmniChat server; the server relays runs to it.

```
OmniChat app ──WS/REST──> OmniChat server <──outbound WS── bridge (PC) ──spawn──> dsh headless
```

## Why `dsh headless`, not the web UI's /api
`dsh --profile headless --json "<task>"` is the documented, stable surface: one task per process, NDJSON run events on stdout, resumable with `--session-id`. The web UI's /api is undocumented and behind a browser-trust fence.

## How dsh is launched (verified on this PC, dsh 44.0.0)
`dsh.cmd` is just: `ELECTRON_RUN_AS_NODE=1 "<app>\DeepSeek Harness.exe" --expose-internals "<app>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" <args>` where `<app>` = `%LOCALAPPDATA%\Programs\DeepSeek Harness`. The bridge spawns the exe directly (no cmd.exe; Node refuses to spawn .cmd without a shell). Args:
`--profile headless [--patch <overlay.yml>] --json [--session-id <id>] -` and the prompt is written to **stdin** (the `-` task reads stdin) — this avoids all quoting problems. Process cwd = the bridge's configured workspace dir (dsh uses it as the session cwd). Read stdout/stderr as UTF-8. Exit code 0 = ok.
`--patch` overlay (already in repo: bridge/dsh-overlay.yml) selects the default model (opencodex / lm-studio/lfm2.5-24b-a2b) without touching ~/.dsh. Configurable via `--dsh-patch`; optional.

## dsh NDJSON events (observed; one JSON object per line)
```
{"type":"session","sessionId":"session-<uuid>","cwd":"..."}          // first line; capture sessionId
{"type":"status","phase":"turn_start"|"step_start"|"step_end"|"turn_end","turn":1,"step":1,"usage"?:{...},"reason"?:{"kind":"completed"|"error","error"?:{"message","code"}}}
{"type":"thinking","text":"..."}
{"type":"text","text":"..."}                                         // assistant text chunk (append)
{"type":"tool_call","callId":"..","tool":"glob","input":{...}}
{"type":"tool_result","callId":"..","status":"completed"|"error","result":"..."}
{"type":"final","text":"<full final message>"}
```
Errors (e.g. missing credentials) appear as `turn_end` with `reason.kind=="error"` and a message on stderr; exit code != 0.

## Bridge <-> server wire protocol (WebSocket, JSON text frames)
Bridge connects to `ws(s)://<server>/bridge?token=<user token>&name=<bridge name>`. Same token/auth as the app (the bridge belongs to that user; one live connection per (user,name); a new connection with the same name replaces the old).

Server -> bridge:
- `{type:"run", runId:string, sessionId:string|null, prompt:string}`  start a dsh run (sessionId null = new dsh session)
- `{type:"cancel", runId}`                                          kill that run's process tree
Bridge -> server:
- `{type:"ready", name, cwd, dshVersion?}`                           once after connect
- `{type:"event", runId, event:<raw dsh NDJSON object>}`            forwarded as-is, in order
- `{type:"done", runId, ok:boolean, sessionId:string|null, error?:string}`  exactly once per run (also after cancel, ok:false error:"cancelled")
- Both sides answer WS ping/pong; bridge reconnects with exponential backoff (1s..30s) and re-sends `ready`. If the connection drops mid-run, the bridge kills that run (server treats a dropped bridge as run failure).
Limits: one concurrent run per bridge is fine for MVP (reject extra with `done ok:false error:"busy"`).

## Server provider kind `dsh-bridge`
Provider config: `kind:"dsh-bridge"`, `baseUrl` = bridge **name** (e.g. `my-pc`), `model` = free text (ignored; shown in UI), no apiKey.
- Conversation <-> dsh session mapping stored server-side in table `agent_sessions(conversation_id PK, provider_id, session_id)`; created from the first run's `session` event / `done.sessionId`.
- Only the latest user message is sent as `prompt` (the dsh session already holds history). If a conversation has no stored session yet, send the whole visible history as a preamble? -> NO, just the latest message; new session.
- Event -> assistant text mapping (markdown appended to the message content): `text` -> text as-is; `tool_call` -> `\n\n> 🔧 <tool> <short JSON input, <=120 chars>\n\n`; `tool_result` with status error -> `> ⚠️ <tool> failed: <first 120 chars>\n\n` (completed results are omitted); `thinking`, `status`, `session`, `final` -> not shown (`final` only used if no `text` was ever received). `done ok:false` -> throw Error(error) so the message ends with status error.
- AbortSignal (user pressed Stop) -> send `cancel`.
- If the named bridge is offline: error "Bridge '<name>' is offline. Start the bridge on your PC."
- `GET /bridges` (authed) -> `{bridges:[{name, cwd, online:true}]}` for the app/settings.

## Security notes (document in README)
- dsh headless executes tools (shell, files) **without approval prompts** in the bridge's workspace dir and with the user's OS permissions. Anyone with the OmniChat account can drive it. Use a strong password, HTTPS, and a dedicated low-privilege workspace dir (`--cwd`).
- The bridge never opens a listening port. The conversation can't choose the cwd; it's fixed by the bridge's `--cwd`.
