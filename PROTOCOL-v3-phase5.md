# OmniChat v3 phase 5: rich content and chat management (extends PROTOCOL-v3.md and phases 2-4)

Scope: Markdown/tables/charts in messages, automatic context compression, default context settings, side panel for documents (Markdown / Word / PowerPoint), one-click message actions, pinned chats, icon replacement. UI polish comes AFTER all of this.

## 1. Pinned chats (server + app)
- `Conversation` gains `pinned: boolean` and `pinnedAt: number | null` (ms). DB columns `pinned INTEGER DEFAULT 0`, `pinned_at INTEGER` on `conversations` (migration in a new `migrate-p5.ts`, idempotent).
- `PUT /conversations/:id` accepts `{pinned: boolean}`; setting true stores `pinnedAt = now`, false clears it. It bumps `seq` and syncs/upserts like any other field (WS `upsert`, `GET /sync`, snapshot). Export/import carry it.
- App: sidebar lists pinned chats first (newest `pinnedAt` first) under a "Pinned" header, then the rest as today. A pin/unpin action on each row and in the chat header.

## 2. Automatic context compression
- Settings gain `contextCompressAt: number | null` (percent 50..95; default `80`; `null` = off, only react at overflow as today) and `contextCompressTarget: number` (percent 20..80, default 50).
- Behaviour (server, `context.ts`): when the prompt would use >= `contextCompressAt`% of the known context limit and `contextOverflow` is `truncate` or `summarize`, the oldest whole user+assistant pairs are replaced by ONE summary note (same mechanism as the existing `summarize`) until the prompt is <= `contextCompressTarget`% of the limit. The newest messages and the system message are never dropped. A failed summary call falls back to plain truncation (as today). `stop` mode is unchanged.
- The result is reported like the existing `ContextAction` (`mode:"compress"`, `summarized`, `droppedMessages`) in the message's context info so the UI can show "Compressed N earlier messages". Original messages are NEVER deleted from the chat; only the request is shortened.
- Validation like the other settings in `PUT /settings` (400 on bad values). Config export/import carry both keys.

## 3. Default context settings
- Settings gain `defaultContextLength: number | null` (256..10_000_000): used (a) as `contextLength` when the app loads a model and the user did not type one, (b) as the assumed limit for backends that do not report one. `settings.contextLimits` (per model) still wins over it.
- App: Settings > Context section edits `defaultContextLength`, `contextCompressAt`, `contextCompressTarget` (with a short help text each) next to the existing overflow mode.

## 4. Artifacts: documents shown in a right-hand panel
- A fenced code block in an assistant message with the info string `artifact` opens in the panel. Format:
  ````
  ```artifact type=markdown title="Meeting notes"
  # content ...
  ```
  ````
  `type` is `markdown` (default), `html` (rendered in a sandboxed iframe on web; shown as source on native), `docx` or `pptx`. For `docx`/`pptx` the content is Markdown that the server converts (see below): `#`/`##` headings, paragraphs, bullet lists, tables, bold/italic; for `pptx` each `#`/`##` heading starts a new slide and the lines under it become that slide's bullets.
- The panel (app): a right-hand column on wide screens (>= 900 px), a full-screen sheet on narrow ones. Tabs: Preview / Source. Actions: Copy, Download (`.md`, `.docx`, `.pptx`, `.html`), Edit (Markdown source editable; edits stay local to the panel and can be sent back with "Use in chat").
- Server: `POST /artifacts/convert {type: "docx"|"pptx", title?: string, markdown: string}` (auth required, body <= 1 MB) -> binary response with the right `Content-Type` and `Content-Disposition: attachment; filename*=UTF-8''<title>.<ext>`. Implemented with the npm packages `docx` and `pptxgenjs` (add as server dependencies; no native binaries). Invalid type/body -> 400.
- Phase 7 additions (office + email): `type` also accepts `xlsx` and `email`.
  - `xlsx`: Markdown where each `## Name` heading starts a sheet and the Markdown tables are the grid (first row = header, bold + frozen). Cells starting with `=` become real Excel formulas (cell refs count the header as row 1, e.g. `=SUM(B2:B9)`); numeric strings (`1,234.5`, `12%`) become numbers. Sheet names are sanitized to Excel rules (<= 31 chars, no `[]:*?/\`, de-duplicated). `POST /artifacts/convert {type:"xlsx"}` is implemented with `exceljs`.
  - `email`: content is header lines (`To:`, `Cc:`, `Bcc:`, `Subject:`), a blank line, then the body. Rendered as a mail card; the app builds `mailto:` links (URL-encoded, body shortened to fit ~1800 chars with a toast) and `.eml` files (RFC 5322, base64 UTF-8 body, RFC 2047 encoded-word subject, `X-Unsent: 1`) on the client. The system prompt (`RICH_CONTENT_NOTE`) tells the model to reply in the email's language, never invent facts and mark gaps as `[要確認: ...]`.
  - Previews are client-side. The Markdown model (`server/src/docmodel.ts` == `app/src/docModel.ts`, slide splitting included) and sheet model (`server/src/sheetmodel.ts` == `app/src/sheetModel.ts`) are byte-identical shared files; `app/src/__tests__/officeSync.test.ts` fails if they drift. Formula display uses `app/src/sheetEval.ts` (SUM/AVERAGE/MIN/MAX/COUNT, + - * / on refs; anything else shows the formula with an `fx` marker).
  - `POST /artifacts/import {filename, data: base64}` (auth required, <= 5 MB decoded -> else 413; unsupported extension 415; unreadable file 422; bad body 400) -> `{type, title, content}`: .docx -> docx Markdown (headings, paragraphs, lists, tables), .xlsx -> `##` per sheet + table (formulas kept as `=...`, caps 5000 rows x 100 columns), .pptx -> `##` per slide with bullets, .eml -> email, .md/.markdown/.txt -> markdown, .csv -> xlsx.

- Slide shapes (`pptx`): a ```` ```shapes ```` YAML block under a slide heading draws shapes, arrows, charts and free-placed text on that slide; `body` (top|left|right|none) says where the slide's bullet text goes. Design and limits: `docs/design/SLIDE-SHAPES.md`. The YAML is parsed and validated on the server (`server/src/shapes.ts`); a block that does not parse stays a code block. In `docx` it becomes a "(図)" line with the element texts; in `xlsx` it is ignored.
- Server: `POST /artifacts/convert/preview` takes the same body as `/artifacts/convert` (`{type, title?, markdown}`, auth, <= 1 MB) and answers JSON `{slides: [{title, blocks}]}`. Each `shapes` block is `{kind: "shapes", raw, spec}` where `spec` is the validated `ShapesSpec` (coordinates are 0-100 percentages; a block without `spec` is a code block). The client previews from this.

## 5. Rich message content (app only)
- Assistant and user messages render GitHub-flavoured Markdown: headings, bold/italic/strike, inline code, fenced code with language label and a Copy button, block quotes, ordered/unordered/task lists, links (open externally), horizontal rules, tables (horizontally scrollable on narrow screens), images by URL. While streaming, an unfinished block renders as plain text without flicker. No raw HTML is ever executed.
- Charts: a fenced block with info string `chart` containing JSON `{type: "line"|"bar"|"pie", title?, labels?: string[], series: [{name, data: number[]}]}` renders an inline chart (reuse/extend `components/LineChart.tsx`; add bar and pie). Invalid JSON shows the raw block with a small "invalid chart" note.
- The model is told about these formats by a short note appended to the system prompt (server, `prompts.ts`, behind the same switches as the date block: `OMNICHAT_INJECT_DATE=0` also disables it): "You may use Markdown, tables, ```chart JSON blocks and ```artifact blocks."

## 6. One-click message actions (app only)
- Replace the overflow menu on `MessageView` by visible icon buttons under each message (shown on hover on web; always visible on touch): Copy, Regenerate (assistant), Edit & resend / branch (user), plus the existing branch switcher. A confirmation toast after Copy. Keyboard: the buttons are focusable.

## 7. Icons (app only)
- One `components/Icon.tsx` wrapping `@expo/vector-icons` `MaterialIcons` (Google Material icon set), `name` + `size` + `color` props, with a name map so an Icooon-mono SVG set can be added later. Replace emoji/character glyphs used as icons across the app (`⟳`, `🔍`, `✓`, `▾`, `←`, `+`, `⋯` ...). Text labels stay.

## 8. Ownership
- Server agent: sections 1-4 (server part) + the system note of section 5, tests in `server/src/*.test.ts` (new `phase5.test.ts`), docs line in `docs/API.md`.
- App agent A1: section 5 (Markdown, tables, charts) in new files `components/Markdown.tsx`, `components/ChartBlock.tsx`; minimal edit in `MessageView.tsx` (the text render only).
- App agent A2: sections 1 (app), 6, 7, and the Settings > Context part of 3. Edits `MessageView.tsx` action area only.
- App agent A3 (after the server is done): section 4 panel (`components/ArtifactPanel.tsx`, hook-up in `ChatScreen.tsx`).
- Nobody changes protocol types except through `app/src/protocol.ts` additions that match this file.
