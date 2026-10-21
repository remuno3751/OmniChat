# Changelog

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
