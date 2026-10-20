# PROTOCOL v7 - attachments (additive)

Images, documents and audio can be attached to a message. Design: `docs/design/ATTACHMENTS.md`. Code: `server/src/attachments*.ts`, `server/src/vision.ts`, `server/src/routes-attachments.ts`. Tests: `server/src/attachments.test.ts`.

## Storage
* Bytes: `<DATA_DIR>/attachments/<userId>/<id>` (unchanged content). Folder 0700, files 0600 (where the OS honours it).
* Extracted text: `<DATA_DIR>/attachments/<userId>/<id>.txt`, name kept in `text_path`. Stored up to 2,000,000 characters.
* Table `attachments`: `id, user_id, conversation_id, message_id, name, mime, kind (image|document|audio), size, sha256, text_path, text_chars, transcript, status (ready|deleted), created_at, deleted_at, seq`.
* An upload is unattached (`message_id` NULL) until a message claims it.

## Settings
* Server setting, key `attachments` in `server_settings`, read by `attachments-settings.ts`. Defaults and ranges:

| key | default | range |
|---|---|---|
| `maxFileMB` | 25 | 1..500 |
| `quotaMB` | 2048 | 0..1000000 (0 = unlimited) |
| `retentionDays` | 0 | 0..3650 (0 = keep forever) |
| `maxPerMessage` | 10 | 1..50 |
| `extractMaxChars` | 60000 | 1000..500000 |
| `transcribeModel` | null | null or `<providerId>::<model>` |

* A bad stored value falls back to the default. The admin write validates strictly.

## Admin API
* `GET /admin/attachments` (admin) -> `{ attachments: {...settings} }`.
* `PUT /admin/attachments` (admin, mutation rate limit, audited as `attachments.update` per changed key) body: partial object of the keys above. Unknown key, out-of-range value or empty body -> 400. Non-admin -> 403.

## User API (all need `Authorization: Bearer`)
* `POST /attachments`: body is the file's bytes. `Content-Type` is the MIME (any type; the server decides from the content). `X-File-Name`: the URL-encoded file name.
  * 200 `{ attachment: { id, name, mime, kind, size, status, textChars }, warnings: string[] }`.
  * `warnings` lists what did not work but did not stop the upload (extraction failed, scanned PDF, no transcription model, transcription failed).
* `GET /attachments/:id` -> the bytes. Headers: `Content-Type` = stored MIME, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`, `Cache-Control: private, no-store`. `Content-Disposition: inline` for png/jpeg/webp/gif, `attachment` for everything else.
* `DELETE /attachments/:id` -> `{ ok: true }`. Removes the bytes and the text. The row stays as `deleted`, so the message shows "(deleted)".
* `GET /attachments?conversationId=` (optional, 1..64 characters) -> `{ attachments: [meta + textChars, createdAt, conversationId, messageId], usage: { bytes, count } }`, newest first, at most 500.
* Other users' attachments: always 404 (`attachment_not_found`), for read, delete and list.

## Errors
Body: `{ error: "<message>", code: "<code>" }`.

| status | code | when |
|---|---|---|
| 400 | `attachment_invalid` | bad list / id / query |
| 400 | (none) | empty file |
| 404 | `attachment_not_found` | missing, not yours, or file gone |
| 410 | `attachment_deleted` | already deleted |
| 413 | `attachment_too_large` | larger than `maxFileMB` (checked from Content-Length before the body is read, and again after) |
| 415 | `attachment_type_not_allowed` | refused type, content not matching the extension, archive, script, SVG, unknown binary |
| 507 | `attachment_quota_exceeded` | would exceed `quotaMB` |
| 400 | `attachment_too_many` | more than `maxPerMessage` ids in a claim |
| 409 | `attachment_already_attached` | claim of an attached or foreign-claimed row (claim only, returned as a result) |

## Format rules
* Magic bytes and extension must agree. Accepted: png, jpeg, webp, gif; pdf; docx, pptx, xlsx (OOXML, checked by their entries); wav, mp3, ogg, flac, m4a, webm; text (UTF-8 or Shift_JIS, no NUL) with an extension from the text list (txt, md, csv, tsv, json, xml, html, log, and common source code).
* Refused: executables (MZ, ELF, Mach-O), scripts starting with `#!` unless the name ends in `.sh`, `.exe .dll .bat .cmd .ps1 .msi .apk .jar .app` and similar, archives (`.zip .7z .rar .gz .tar` ...), SVG, anything with a mismatched extension.
* File names: last path part only, control characters and `<>:"|?*` removed, leading dots removed, at most 200 characters (the extension is kept), `file` when empty.

## Text and transcription
* Documents: txt/md/csv/json/xml/html/code as text (html without tags and scripts); docx `<w:t>` runs; pptx `--- スライド N ---` and notes; xlsx one TSV block per sheet (2000 rows x 50 columns); pdf text layer `--- ページ N ---` (at most 200 pages, 20 s per extraction).
* Office and pdf inputs are read with a 100 MB expanded-size limit (zip-bomb guard).
* Audio with `transcribeModel`: `POST <base_url>/audio/transcriptions` (multipart: `file`, `model`), with the provider key. The key is not logged and not returned.

## Model path (contract for the chat path)
Server functions (`attachments.ts`), not HTTP:
* `getAttachmentRow(id) -> AttachmentRecord | undefined` (camel-cased row).
* `attachmentsForMessage(messageId) -> AttachmentRecord[]` (in `position` order from `message_attachments`, deleted ones included).
* `claimAttachments(userId, ids, conversationId, messageId) -> { ok: true } | { ok: false, code, message }`: all or nothing; ids unique, at most `maxPerMessage`, owned, ready, and unattached or already used in the same conversation (so an edited message can reuse them; another conversation's attachment is `attachment_already_attached`). Writes `message_attachments` (with positions) and fills `attachments.conversation_id` / `message_id` only the first time. `checkClaim` runs the same rules without writing.
* `loadAttachmentForModel(rec) -> ModelAttachment | null`: `{ kind, mime, name, dataUrl? (images), text? (documents: extracted text; audio: transcript), truncated? { total, shown } }`. `null` for a deleted row or a missing file. Text is cut to `extractMaxChars`.
* `attachmentMeta(rec) -> { id, name, mime, kind, size, status }`.
* `userUsage(userId) -> { bytes, count }` (ready rows).
* `storeUpload`, `deleteAttachment`, `removeFiles`, `attachmentsOfUser`, `userDir`, `filePathOf` are used by the routes and the retention job.

Vision (`vision.ts`): `visionSupport(providerRow, modelId, modelEntryMeta?, overrides?) -> "yes" | "no" | "unknown"`. `overrides` is `settings.modelVision` (`"<providerId>::<model>"` -> boolean). `ModelEntry.vision` is set by `parseModels` only when the model list says something (`architecture.input_modalities`, `modalities`, `capabilities`, `vision`, `input`, `type: "vlm"`).

Settings: `modelVision: Record<string, boolean> | null` in the user settings (`PUT /settings`, validated: an object of booleans or null).

## Retention
* `runRetention(now)`: does nothing when `retentionDays` is 0. Otherwise deletes (files and text, row `deleted`) ready attachments older than N days, and unattached ones older than 24 hours.
* Started once at server start, then every 6 hours (`startRetentionJob`, timer unref'd).
* Delete links: see "Deleting" below.

## Chat path (send, messages, LLM)
* **Table** `message_attachments (message_id, attachment_id, position, PRIMARY KEY (message_id, attachment_id))`, index on `attachment_id`. One attachment may belong to several messages of the same conversation.
* **WS `send`** takes `attachmentIds` (string[], default `[]`). Regenerate ignores it (the original user message's attachments are used). Ephemeral chats refuse attachments.
* **Error** `{ type: "error", code: "attachment_invalid", message, conversationId, messageId }` (messageId = the assistant message id). Used for a wrong type, duplicates, too many, an unknown or foreign id, a deleted file, or a file of another conversation; `message` starts with the detail code (`attachment_not_found`, `attachment_too_many`, ...). Nothing is stored and the upstream is not called. The check runs before the context check; the claim itself happens right before the user message is inserted. A resend of an existing user message does not claim again.
* **Message JSON** (sync, upsert, history, branches, snapshot): user messages carry `attachments: [{ id, name, mime, kind, size, status }]` in position order (omitted when none; deleted ones stay with `status: "deleted"`). No bytes, no text.
* **To the LLM** (`attachments-chat.ts`; messages without attachments are sent as before, byte for byte): the user text becomes `notes + "

" + text`.
  * document / audio transcript: `[添付: <name>]
<text>` (cut: `
(以下省略: 全 N 文字中 M 文字)`); audio without transcript `[添付: <name>(文字起こしなし)]`; deleted or missing file `[添付: <name>(削除済み)]`.
  * images: sent as OpenAI `image_url` parts (data URL) only when vision is `yes` and the provider is `openai-compatible`; at most 4 per request, the newest first, older ones become `[画像: <name>(省略)]`. Vision `no` / `unknown`: no bytes, `[画像 <name> は、このモデルでは読めません]`. Vision = user override (`modelVision`), else the model list (`ModelEntry.vision`), else `unknown`.
  * `dsh-bridge` (Code): documents as `[添付: <name>]` + extracted text, the text of one message held to `extractMaxChars` in total. Images and audio are refused on send (`attachment_invalid`, message `attachment_not_supported_in_code: ...`, nothing stored). Design: `docs/design/ATTACHMENTS.md`, "Code / DSH での添付".
  * In code, `ChatMessage.content` stays a string (the text form); images travel in `ChatMessage.parts` and `openai-compatible` sends `parts` as the body `content`.
* **Context usage**: `used.attachments` = estimated tokens of the notes and attachment text plus 800 per image sent; it is taken out of `used.history`, and `total` counts it once.
* **Export**: conversation JSON / Markdown list each message's attachments (name, kind, mime, size, status; never content). Import ignores the field.

## Deleting
* Conversation delete (`DELETE /conversations/:id`, soft): its attachments are deleted (files and text, row `deleted`), except those also attached to a message of another live (not deleted) conversation.
* Message delete (`deleteAttachmentsOfMessage`): same rule per message, and its `message_attachments` rows go. (No route deletes single messages yet.)
* Hard user delete: the user's files are deleted before the rows are purged. Disabling a user and deleting a provider delete nothing.
