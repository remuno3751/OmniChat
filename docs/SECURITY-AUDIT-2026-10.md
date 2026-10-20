# Family-sharing security audit (2026-10)

Scope: shared providers (docs/design/SHARED-PROVIDERS.md, docs/PROTOCOL-v7-shared-providers.md), attachments (docs/design/ATTACHMENTS.md), and the server routes for providers, sync, chat/compare/bench, /v1, conversations, search, artifacts, checkpoints, tool grants, code preview, and admin.

Method: route-by-route review of ownership and admin checks, every call site that loads a provider row or calls an upstream model, and every place a provider error or debug record is stored or returned.

Files changed in this pass are listed at the end. Files marked forbidden for this worker are reported here, not edited.

## Findings

| ID | Severity | Where | Issue | Status |
|----|----------|-------|-------|--------|
| F-1 | High | server/src/providers/openai-compatible.ts (`stream`, non-2xx branch) | The raw upstream error body was stored in `response.raw` of the debug record without scrubbing. A borrower reads that record through `GET /messages/:id/debug` (routes-chat.ts:403), so the owner's base URL and key could appear in it when upstream echoes them. | Fixed. Upstream text is now passed through `scrubUpstream` (owner key to `[key]`, owner base URL to `[url]`, Authorization/Bearer/api-key values masked). Test: server/src/debug-scrub.test.ts (fails without the fix, passes with it). |
| F-2 | Medium | server/src/providers/openai-compatible.ts (`stream`, fetch call) | An error thrown by `fetch` itself can echo the URL (for example "Failed to parse URL from ..."). That text flowed into message content, bench results and compare errors unscrubbed. | Fixed. The fetch rejection is rewrapped with `scrubUpstream`, keeping the error name so abort handling is unchanged. Test: server/src/debug-scrub.test.ts (second test). |
| F-3 | Medium | server/src/bench.ts:181, :263, :296 | Bench stores `r.error` for shared-provider runs without `scrubForUser`. It is returned to the borrower in the run JSON and in the CSV export. Only the provider-level scrub (F-1/F-2) currently covers this. | Open. bench.ts is a forbidden file. Fix: when `prov.user_id !== userId`, apply `scrubForUser(r.error, prov)` (and `maskSecrets`) before storing the item, near bench.ts:170-181. |
| F-4 | Medium | Existing `messages.debug` rows written before F-1 | Debug records saved before this fix can still contain the owner's URL or key text in `response.raw`, and borrowers can still read them through GET /messages/:id/debug. | Open. Needs a one-off data migration (not run without approval). Suggested: for messages whose conversation provider is a shared row owned by another user, rewrite `debug` through `scrubUpstream` or set it to NULL. Admin backups (admin-only) still contain the old data. |
| F-5 | Low | server/src/chat.ts:743-767 (debug save) | Non-owner debug records are saved without scrubbing. The protection now comes entirely from the provider layer. Tool-call `error` and `search.error` fields are not scrubbed either. | Open. chat.ts is a forbidden file. Defense in depth: when `prov.user_id !== userId`, pass the record through `scrubForUser` (JSON-string walk, excluding `final.messages`). |
| F-6 | Low | server/src/search/index.ts:183, :194, :214 (`searchStatus`) | `GET /search/status` (any authenticated user) returns `lastError` from the SearXNG probe. The text may include the configured SearXNG URL. Not verified against a live failure. | Open (not verified). Suggested: replace `cfg.searxngUrl` in the probe error with the host before returning it. |
| F-7 | Low | server/src/prompts.ts:126 | The effort profile is read from `getProviderRow(input.providerId)` without a usable check. Only the mapped effort value is affected, and that value already appears in the borrower's debug record (`effort.sentAs`). No key or URL is exposed. | Open. Suggested: `getUsableProviderRow(userId, ...)`. |
| F-8 | Info | server/src/routes-admin.ts:193 (`/admin/logs`), server/src/diagnostics.ts (`/admin/diagnostics`) | The log ring masks keys, Authorization and URL credentials, but not a plain base URL. Admin-only, so this is an operator view, not a non-owner leak. | Accepted. Could add the base-URL mask if desired. |
| F-9 | Info | server/src/bench.ts:150, compare.ts | Borrowers see provider-side errors for their own runs. This is intended. | No action. |

## Checked, no issue found

- **Shared provider views**: `sync.ts` (via `listSharedProvidersFor`) and `GET /providers/:id/models` never return base URL or key to non-owners (asserted by shared-use.test.ts test e).
- **Provider mutation**: PUT/DELETE `/providers/:id` check `row.user_id`. POST `/providers/:id/models/load|unload` (routes-models.ts:21) checks owner. `/providers/:id/models` and `/loaded` use `getUsableProviderRow`.
- **Model gating before any upstream call**: `refuseModelDenied` (chat.ts) runs before storing or sending. Compare and bench use `getUsableProviderRow` and `modelDenied`. Title generation, summaries (compact) and context measurement reuse the already-gated provider, or resolve it with `getUsableProviderRow`.
- **/v1 API**: keys resolve to the user; `sharedRowsFor` applies grants; denied models return 403, unusable providers 404.
- **Attachments**: `ownedRow` (routes-attachments.ts:25) and `checkClaim` (attachments.ts:236) enforce owner. Retention and listing queries filter by `user_id`.
- **Conversations and derived data**: export (`getOwnedConversation`), context (routes-visibility.ts), compact (routes-compact.ts:45), PUT conversation, history search (history-search.ts filters `c.user_id` in both MATCH and LIKE branches), sessions and checkpoints (code.ts, rewind checks `cp.user_id`).
- **Code preview and preview frame**: `resolveConversationBridge` requires conversation owner. Preview frame has no data.
- **Tool grants**: `/tool-grants` is user-scoped. Deleting a grant only affects the caller's own rows.
- **Admin routes**: all `/admin/*` handlers use `requireAdminUser`, `requireAdmin` or `adminOnly`. `/tools/reload`, `PUT /search/config` and `/search/test` are admin-only. `/admin/plugins/*` uses `respond` (admin check). Backup paths are sanitized (backup.ts `backupPath`).
- **Config export/import**: export lists only the caller's own providers (id and name, no key). Import runs as the caller.
- **Exports**: user export does not include `messages.debug`.

## Verification

- `npx tsc --noEmit` (server/): clean.
- `npx tsx --env-file=test.env --test src/debug-scrub.test.ts`: 2 of 2 pass. Verified the first test fails before the fix.
- `src/providers/openai-compatible.test.ts`: 6 of 6 pass.
- `src/shared-use.test.ts`, `src/shared-providers.test.ts`, `src/openai-api.test.ts`, `src/compare.test.ts`, `src/bench.test.ts`: 36 of 36 pass.

## Files changed

- server/src/providers/openai-compatible.ts: `scrubUpstream`, `mapStrings`, scrubbed debug raw and error text, fetch rejection rewrap.
- server/src/debug-scrub.test.ts (new): borrower debug record and fetch-error tests.
- THIRD_PARTY_NOTICES.txt: see the notices note below.
- docs/SECURITY-AUDIT-2026-10.md (this file).

## Notices note

Missing direct dependencies were added: exceljs 4.4.0, expo-document-picker 57.0.3, expo-image-picker 57.0.20, expo-local-authentication 57.0.3, react-native-webview 13.16.1, react-native-safe-area-context 5.7.0. With them, 156 server transitive packages (exceljs closure) and 6 app packages were added, each with its LICENSE text from node_modules. A closure check over all production dependencies of server and app now reports zero missing packages.

Needs manual verification: buffers 0.1.1, binary 0.3.0 and chainsaw 0.1.0 declare no license field in package.json (the entries say so and cite MIT per the authors' repositories). Packages that ship no LICENSE file have a note with the declared license and author (for example saxes 5.0.1, ISC). Only the MIT-declared ones without a file got the MIT template text, with the author as copyright holder. The license-checker tool was not installed, so the entries were generated from node_modules instead of by the tool.

# Review pass 2: plugin install, plugin sandbox, quotas (branch review/plugins-quota-2026-10)

Scope: server/src/plugin-install.ts, plugin-scan.ts, routes-plugins.ts, local-admin-mirror.ts, plugin-sandbox.ts, plugin-host.mjs, tools/registry.ts, quota.ts and its hooks (chat.ts, compare.ts, bench.ts, openai-api.ts, compact.ts, context.ts), attachments-chat.ts. Reviewed at a8f12c7 on Linux, Node 22.22. Line numbers below are at a8f12c7 (before the fixes). Every defect has a test in a `*-review.test.ts` file that fails without the fix.

## Confirmed and fixed

| ID | Severity | Where (a8f12c7) | Issue and reproduction | Status |
|----|----------|-----------------|------------------------|--------|
| I-3 | High | plugin-install.ts:446 (`writeFolder`), :447 (row insert) | A new plugin's folder was renamed into place before its `plugin_installs` row existed. The loader treats a folder without a row as a hand-placed plugin and imports it enabled. Any reload in that window (another admin action, `POST /tools/reload`, a restart after a failed install) ran the plugin's code before the administrator enabled it. Repro: install while three clients spam `POST /tools/reload`; the plugin's top-level code wrote its marker file (1 of 10 installs in the first run). Also, a failure after the rename (the `inspection_mismatch` check at :421) left the unreviewed folder behind, which the next reload then ran. | Fixed. A new plugin gets its disabled row first (removed again if the write fails), and the staged files are verified before anything is renamed. Test: plugin-install-review.test.ts "I-3". The leftover-folder path needs a zip that lands on one path twice, which JSZip normalizes away on Linux; it can still happen on a case-insensitive file system (Windows, macOS: `Index.mjs` and `index.mjs`), so that part is fixed by reasoning and not covered by a test. |
| I-2 | Medium | plugin-install.ts:299-300 | The zip was downloaded first and the commit resolved second. If the ref moves in between, the recorded `commitSha` belongs to different code than the inspected files, so `check-update` ("no update") and the audit log describe the wrong code. Repro: fake GitHub moves HEAD after the first zipball; `source.commitSha` is the new commit while the manifest is the old version. | Fixed. The commit is resolved first and the zip is fetched by that sha. Test: "I-2". |
| I-1 | Medium | plugin-install.ts:431-442 | The inspection was marked used only after two awaits, so parallel `install` calls with the same `inspectionId` could all pass the single-use check; some then failed in `writeFolder` with 500, the others installed. Repro: 3 parallel installs of one id (flaky on the old code, 500 seen). | Fixed. The inspection is claimed before the first await and handed back if the conflict or hash check fails. Test: "I-1" (the race is timing dependent, so this test can also pass on the old code). |
| I-4 | Medium | plugin-install.ts:535 (grants are only cleared on delete) | Saved tool approvals (`tool_grants`, "always allow" rules) are keyed by tool name only. They survived an update that added a permission to the tool (for example `network` to `network`+`shell`), and a new plugin that reuses the tool name of a disabled or removed plugin started pre-approved. Repro: grant `net_tool`, update the plugin with an extra `shell` permission; the grant is still there. | Fixed. Install revokes the approvals of every new tool name and of every tool that gained a permission. An update without new permissions keeps them. Test: "I-4". |
| Q-2 | Medium | compact.ts:51, context.ts:305 and :391 | `POST /conversations/:id/compact` (and the in-turn "summarize" overflow policy) sent the whole transcript to a shared provider with the owner's key, with no quota check and no accounting. A user at the limit could keep compacting. Repro: limit reached, `/compact` returns 200 and the upstream is called. | Fixed. `/compact` is refused with 429 at the limit and both summary paths count the upstream usage (estimate when absent). Test: quota-review.test.ts "Q-2". |
| Q-4 | Medium | chat.ts:563 | Only the last upstream call of a turn was counted. A turn with tool rounds re-sends the whole context every round, so a 3-round turn was counted as 1 call. Repro: fake upstream reporting 10 tokens per call, 3 rounds: 10 counted, 30 expected. | Fixed. Earlier rounds are summed (reported usage, else an estimate) and added when the turn finishes. Side effect: `sink.response.usage` is cleared after each tool round, so the final metrics no longer reuse an earlier round's usage when the last round reports none. Test: "Q-4". |
| Q-3 | Low | compare.ts:151 (entry check only) | A sequential compare of up to 4 targets checked the limit once before the first target, so later targets ran past it. bench.ts already re-checks per item. | Fixed. Each target is checked again and gets an error result with the quota message. Test: "Q-3". |
| P-1 | Low (availability) | plugin-sandbox.ts:315-320 (`gone`) | When a call timed out and the child was killed, the old child's `exit` event arrived later and `rejectAll` failed the pending calls of the next child ("plugin process exited (SIGKILL)"). Repro: time out a call, wait until the host reports not running, call again immediately: the second call fails. | Fixed. The exit handler of a child that is no longer the host's current child does nothing. Test: plugin-sandbox-review.test.ts "P-1". |

## Open (not fixed)

| ID | Severity | Where | Issue | Why not fixed |
|----|----------|-------|-------|---------------|
| R-1 | Medium | quota.ts `quotaRefusal` / `recordQuotaUsage`, all entry points | The check happens before a reply and the usage is added after it, so N parallel requests (chats, compares, `/v1` calls) started before any finishes all pass. The contract allows going "a little over" for one reply, but not N replies. | Needs a product decision (reserve a size per in-flight reply, or cap parallel shared replies per user). Not a one-line change. |
| R-2 | Low | chat.ts `quickAsk` (market quote), title.ts auto-title (a title model can be a shared provider), attachments-transcribe.ts | Small helper calls on a shared provider are not counted. Each is bounded per admitted turn or upload. | Bounded; left as is. |
| R-3 | Low | metrics.ts:39 | A reply with no output returns no metrics, so a turn that fails or is stopped before the first token counts 0 even if the prompt was processed. | The contract counts what was produced; charging failed calls is a policy choice. |
| R-4 | Medium (documented limit) | plugin-sandbox.ts | A plugin child can still open sockets directly (already documented and tested as a known limitation) and, in addition, `process.kill(process.ppid)` works under `--permission` (checked), so an enabled plugin can stop the server process. fs reads of sibling folders, the data dir, `/proc/<ppid>/environ`, `process.binding` and `readdir("/")` are denied. | Not fixable inside Node's permission model. Should be added to the UI warning; real containment needs an OS-level sandbox. |
| R-5 | Low | plugin-sandbox.ts `proxyFetch` | `ctx.fetch` runs in the parent and is not cancelled when the call is aborted; the 15 s timeout is a socket idle timeout, so a slow-drip response can hold a request for a long time (size is capped at 2 MB, 5 redirects). | Low impact; left as is. |
| R-6 | Info | plugin-sandbox.ts `isBlockedAddress` | `::ffff:0:a.b.c.d` (SIIT) is not in the block list. It is not loopback on a normal host. Everything else tried is blocked (checked list below). | Not exploitable on a normal host. |
| R-7 | Low, unverified | openai-api.ts:104 and :138 | `stream` is only treated as streaming when it is the boolean `true`. A non-boolean value is forwarded upstream; if an upstream still answers with SSE, the non-stream branch cannot parse it and counts nothing. | Not reproduced (depends on the upstream). |
| R-8 | Low | plugin-install.ts | Two installs of the same new id from different inspections are not serialized (the second replaces the first). | No security impact found. |

## Checked, no defect found

- Zip handling: `..`, absolute, drive-letter and backslash names are refused for every entry; symlink entries are refused; written files are plain files; a forged smaller declared size is caught by JSZip before memory grows (400 MB payload probe: peak growth 36 MB); the 5 MB / 2 MB / 200 file limits hold. Duplicate and `./` names collapse on load.
- GitHub input: `repo`, `ref` and `subdir` are whitelisted, ref segments are URL-encoded, only `https://github.com/` is accepted, redirects stay on GitHub.
- Inspections are bound to the admin that created them (`userId`), single use, 15 minute TTL. All plugin routes require an enabled admin.
- `ctx.fetch`: probed with `0x7f.0.0.1`, `2130706433`, `017700000001`, `127.1`, `[::ffff:7f00:1]`, `[::ffff:127.0.0.1]`, `[::]`, `[::1]`, `0`, `localhost`, `127.0.0.1.`, full-width digits, `[64:ff9b::7f00:1]`, `[2002:7f00:1::]`, `[::127.0.0.1]`, `169.254.169.254`, `100.64.0.1`, `[fd00::1]`: all refused. DNS is resolved once and the connection is pinned to the checked address (no rebinding); every redirect hop is re-checked; responses are capped at 2 MB.
- Child process: empty environment, no write/spawn/worker/addon, reads only the plugin folder (sibling folders and prefix-named files denied), IPC messages can only settle the child's own pending calls, `ctx.fetch` requests are honoured only for calls that declared `network`.
- local-admin mirror: only the listed method and path pairs are registered; `..` and encoded dot segments end at the inner route's id check; the forwarded token never leaves the process; requests with forwarding headers are refused.
- Quota routes: `/admin/quotas*` use `requireAdminUser`; `/quota` is the caller's own; overrides are strictly validated.
- Attachments on the chat path: `checkClaim` and `claimAttachments` require ownership, so another user's attachment id is `attachment_not_found`; `codeDocumentNote` only reads rows that were claimed by the sender; nothing is stored when `attachment_invalid` is returned.

## Tests

- New: plugin-install-review.test.ts (4), plugin-sandbox-review.test.ts (1), quota-review.test.ts (4, one of them a checked non-defect: ending an ephemeral chat mid-reply still counts the tokens).
- Baseline at a8f12c7 on Linux, Node 22.22: 7 failures, all in src/updater (the bundle check requires Node 24; this machine has 22.22). No failures elsewhere.
