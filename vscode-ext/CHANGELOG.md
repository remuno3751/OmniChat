# Changelog

## 1.0.1

- No functional change; the version follows the OmniChat 1.0.1 release.

## 1.0.0

- Pairing is now copy and paste only: create the pairing code in the OmniChat app (Settings > VS Code), run **OmniChat: Pair with Server** and paste it. The `vscode://` link ("Open in VS Code") and its URI handler are removed, because VS Code rejected the link as an invalid pairing code on some setups.

## 0.4.0

- Chat settings: the gear in the Chat header opens "Settings for this chat" (system prompt, append or replace the default instructions, thinking effort). Saved per conversation on the server (needs server 0.5.6-d or later).
- Thinking effort chip in the picker bar (off, low, medium, high, max, or the model default). Also `/effort <off|low|medium|high|max|default>`.
- `/rename <title>` renames the open conversation.
- History search: a search box above the conversation list searches all conversations of this bridge (titles and messages), and a hit opens its conversation and scrolls to the message.
- `/export json` opens the conversation as a JSON document (messages and tool rows; no tokens, keys, folders or device names).
- Slash commands take an argument now (up to 2000 characters).
- Checkpoints panel: the "Checkpoints" button in the Chat header lists the states before each agent run (newest first, up to 50), with the time, the request, and the number of changed files. "Restore" asks in a modal dialog first; a cancelled dialog sends nothing. The state just before a restore is kept in a Git backup branch (`refs/omnichat/checkpoints/pre-rewind-…`), and the restore is listed in the transcript as a status line. A second button also removes files created after the checkpoint. Non-Git points and points while a run or unsaved editors block the restore are shown as unavailable, with the reason.
- Sources: an answer that used web search shows "Sources (N)" under the reply. Links open in the browser only for http and https; a source with user info in its URL, or any other scheme, is dropped without dropping the answer.
- Edit the last prompt: "Edit" on the last user message puts its text back in the composer. Sending it removes the answer and tool records after that message and sends the edited text again (files are not restored; use a checkpoint). Not available while a run is active.
- Protocol: `checkpoints_request`, `checkpoint_restore`, `checkpoints` and `checkpoint_restored` frames, and `replaceLast` on `prompt`. Older servers never send them.
- Strings: the new wording is in Japanese and English (`src/ui/stringsV056e.ts`).

## 0.3.1

- Right side bar: "OmniChat: Open Chat in the right side bar" (also the view title bar button) opens the chat in the right side bar. The extension contributes a secondary side bar container (`secondarySidebar`) with its own view that shares the conversation and state of the Chat view and the editor panel. Where VS Code cannot dock on the right, a message says to drag the icon instead. The old command `workbench.action.moveViewToSecondarySideBar` does not exist in VS Code, so the button did nothing before.
- Header: "Open in editor" and "Move to the right side bar" are removed from the header (they stay in the view title bar), so the title has the full width.
- Thinking is its own small row above the answer; the answer bubble holds only the answer text.
- Composer pickers wrap on narrow panels: the folder and model pills share a row when they fit, and the approval and search segments are more compact.

## 0.3.0

- Layout: the Settings view starts collapsed, so Chat keeps its height (the gear in the Chat header still opens it).
- Reasoning is a small collapsed fold above the answer; the answer is plain body text. A finished turn that has no answer text opens its reasoning.
- Long runs of the same tool (3 or more in a row) fold into one line such as "Read file · 4"; open it to see the calls.
- The chat title is cut with an ellipsis (no marquee); on narrow panels the logo and latency are hidden.
- New header buttons: open in an editor tab, and move Chat to the right-hand (secondary) side bar. Both are also in the view's title bar, and "OmniChat: Move Chat to the right side bar" is in the command palette.
- Slash commands: `/pin` (pinned chats sort first in History; kept locally), `/retry`, `/usage`, `/export` (the chat as a Markdown document).
- Cleanups: a stray control byte in `viewModel.ts`, toasts go only to the view that issued the command, Chat is torn down in `deactivate`.
- Code answers in the language the user writes in (server prompt).

## 0.2.9

- Attachments: an attach button, drag & drop and paste in the composer. Documents are sent as text; images only to models that can read them (vision). Limits: 4 files, 4 MB each, 5 MB in total.
- Slash commands: type `/` for a list (Up/Down, Enter or Tab): `/clear`, `/context`, `/model`, `/help`, `/compact`.
- The model picker is now the same list as the app's: grouped by provider, with the context length and a vision tag, and a search box.
- The OmniChat logo button opens a device / folder popup. Star a folder (or a device) to pin it; pins are kept in the extension's global state.
- Hints: hovering a main button for 2 seconds shows a short hint (`data-tip`).
- Queue: removing a queued chip puts its text back in the input; a "run now" button on the chip interrupts the current run (like Ctrl+Enter).
- Copy button on your messages; a "run again" button on the last answer re-sends the previous prompt.
- The scrolling chat title waits 1.5 s at both ends. Command "OmniChat: Open in editor" opens the chat in an editor tab (state shared with the sidebar).
- Click the context meter for a token breakdown (system, history, attachments, tools, last reply).
- Server frames (0.5.5-beta.2): `devices_request` / `devices`, `compact_request` / `compacted`, `prompt.attachments`, and `contextLength` / `vision` on model items.

## 0.2.8

- Faster answers: the server sends only the new text while streaming (`transcriptDelta`; the panel asks for a full transcript if a delta does not fit), and the answer is rendered at most once per animation frame.
- Code changes are shown like Claude Code: every `edit_file` / `write_file` call (also when auto-approved) shows `+N −M` in the tool timeline, and expanding the entry lists the added (green) and removed (red) lines.
- Fix: false "outside workspace" for paths that are inside the workspace (case differences on macOS, /tmp-style aliases, 8.3 short names, symlinked roots).
- Full access really is full for outside-workspace paths: when the server allows it, the tools can read, search and edit paths outside the workspace (secret and .git rules still apply).

## 0.2.7

- Chat is more robust and closer to the app: a "Reconnecting… (retry in N s)" banner with the next retry time, a latency badge, a send button that cannot be pressed while offline (the typed text is kept, double sends are dropped), and a queue: a prompt sent while the assistant is answering waits as a chip and runs afterwards; Ctrl+Enter interrupts the current run.
- Web search mode (Off / Smart / Always) next to the model and approval pickers; it is stored on the conversation. Context usage is shown above the input (token count; the bar when the model limit is known).
- Tool runs are shown as a timeline above the answer ("Ran glob", collapsible); the reasoning block is collapsed ("Thinking…" while streaming); copy buttons are icons; file paths in code and in the timeline open the file in the editor (only inside the workspace).
- The Settings button toggles the view; a long chat title scrolls like the app's model list.
- Fix: the extension dropped the server's `context` frames (they were missing from the codec's list of known frame types).
- Fix: editing an existing file (for example an .md) could fail: a save() that reports "not saved" for an unchanged or auto-saved buffer is now success, the dirty-buffer check matches on Windows paths, mixed CRLF/LF no longer breaks multi-line matches, and the real error is shown.
- Fix: Enter no longer ignored for genuine presses while composing.

## 0.2.6

- Fix: server replies (models, conversations, transcript, prompt_ack) were never handed to the Chat controller, so the model list stayed empty and no answer or history appeared. Verified in a real VS Code against a local server: pair, model list, send, streamed reply, approval card, tool run after approval.
- Mitigation for the rare "Could not register service worker" webview error: the Settings view loads 700 ms after the Chat view, and a view that has not reported ready within 6 s is rebuilt (twice at most).

## 0.2.5

- Japanese: the reasons the server attaches to an approval card ("exec needs approval in manual mode", protected-rule texts such as "path is outside the workspace" or "git push", deny/allow rule hits, "extension: ...") are now shown in Japanese when VS Code runs in Japanese. English stays as is; unknown texts are shown unchanged.
- The error bar's × button and the history drawer's close button now carry a proper "Close / 閉じる" label.

## 0.2.4

- Fonts and look now match the app. Every weight the app uses is bundled and registered with its real weight: Space Grotesk 400/500/700 and Syncopate 400/700 (Frontier), Zen Maru Gothic 400/700 (full Japanese files plus small Latin files), Outfit 400/600 and Marcellus 400 (Astral). Bold text uses the real bold face instead of a browser-faked one.
- Same type roles as the app: body regular/bold, heading face, label face (Frontier: Space Grotesk Medium/Bold in caps with 1.2px tracking; Astral: Outfit 0.6px), per-theme line-height boost, the app's monospace stack for code, and the heading face falling back to the body face for Japanese text.
- Frontier chat drifts fixed: Markdown headings (bold body face with an accent block), 01 02 03 lists and square bullets, quotes with an accent bar, borderless square code blocks with a plain language label and an outlined Copy button, bordered tables with a bold head row, mono tool names, buttons in bold sentence case instead of Syncopate caps. Astral gets the hairline under headings and diamond bullets.

## 0.2.3

- Frontier skin, modelled on the OmniChat app: square panels with corner brackets, 3px left bars on messages, Syncopate and Space Grotesk type, caps `//` section titles, inverted tag plates, and a hatch background. Decorations switch off for high contrast, `omnichat.decorations` set to `off`, reduced motion, and narrow views.
- The old look is now called Simple. The theme picker lists Frontier (default), Simple and Astral, and a change applies at once. Astral is the Simple layout with Astral colours.
- An unset `omnichat.theme` means Frontier. People who already chose `simple` keep Simple.

## 0.2.2

- Chat view rebuilt in the look of the OmniChat app: rounded bubbles, Markdown with highlighted code blocks and a Copy button (the app's own Markdown parser and highlighter are shared), collapsible thinking block, tool cards with status and duration, inline approval cards, a composer with the OmniChat logo as the send button (square stop button while running), model and approval-mode pickers, and a header with connection state.
- Conversation history: a History button opens a drawer with title, relative time and approval mode; click to open a conversation and keep chatting in it.
- Old servers: the server's welcome now advertises features ["chat"]; for servers without chat support (< 0.5.4-beta.2) the Chat view shows a clear "update the server" banner instead of a dead UI.
- Every chat request (prompt, models, conversations, history) times out (10 s; prompt ack 15 s) with a visible error, and Send/Stop recovers. Stop is shown only while a run is really active.
- Friendly messages for no models, no model chosen, quota, forbidden model, closed workspace.
- Settings view restyled like the app settings pages (sections, rows, switches, segmented controls).
- Webview views are created idempotently (fixes repeated webview HTML writes after a VS Code update).

## 0.2.1

- Fix: pairing no longer fails for the usual setup. Plain `http` is now accepted for loopback, private LAN (10/8, 172.16/12, 192.168/16), link-local, Tailscale (100.64/10), IPv6 local addresses, and `.local` / `.lan` / `.home.arpa` / `.ts.net` / `.internal` or single-label host names. Public hosts still need `https`. The client connects with `ws://` for `http` servers.
- Pairing errors now say why (empty, too long, wrong link, bad format, decode error, bad server address, http for a public host, bad token or name), in Japanese and English.
- The pairing paste field is forgiving: whitespace, line breaks, invisible characters, quotes and the full `vscode://` link are accepted.

## 0.2.0

- New name and logo: **OmniChat VS**, with its own icon in the VS Code activity bar.
- Chat view: chat with the server from the sidebar (conversation transcript, prompt box, model and approval-mode pickers, recent conversations for the open folder, live tool rows, Stop).
- Approval cards now appear inline in the Chat view (Allow once / Deny, protected badge, View diff). The separate approval panel is gone; the status bar item opens the Chat view.
- Settings view: server URL, pairing (paste code, Unpair), bridge name, theme, new `omnichat.decorations` setting, autoSave, shell, trust note, Open log. The token is never shown.
- New chat wire frames (`prompt`, `models`, `conversations`, `transcript`, `set_approval_mode`, `stop`, ...) and `capabilities.chat` / `capabilities.transcript` in `ready`. Needs server >= 0.5.4-beta.2 for chat; the tools still work with 0.5.4 servers.
- Japanese and English UI (follows the VS Code display language).

## 0.1.0

- Initial release (Git-distributed `.vsix`; not published to the Marketplace).
- Pairing with a self-hosted OmniChat server via the app's VS Code card (`OmniChat: Pair with Server`, `vscode://` link).
- Workspace tools: read/list/glob/grep, write/edit, diagnostics, git, and `run_command`.
- Approval modes `manual` / `auto` / `full` with a protected-item list that always asks.
- Webview panels for live tool activity and approvals, with `simple` / `frontier` / `astral` themes.
