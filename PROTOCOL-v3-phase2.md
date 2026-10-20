# OmniChat v3 phase 2: visibility (extends PROTOCOL-v3.md; same conventions)

Spec items: 4 context display, 5 speed metrics, 6 latency, 9 (reasoning tokens / collapsed thinking), streaming reconnect (the server-side part, `snapshot`, already exists).

## 1. Reasoning ("thinking") as a separate lane
- `Message` gains `reasoning: string | null` (full thinking text, persisted; null if none). WS `delta` gains `kind?: "text" | "reasoning"` (default `"text"`); reasoning deltas append to `message.reasoning`, text deltas to `message.content`. `snapshot` entries gain `reasoning`.
- Providers: `openai-compatible` reads `delta.reasoning_content` (and the `reasoning` alias used by some servers) and yields reasoning separately; `ChatProvider.stream` may yield `string` (text, as today) or `{ kind: "reasoning" | "text"; text: string }`. dsh-bridge maps NDJSON `thinking` events to reasoning (ignore empty).
- UI default: thinking is collapsed ("Thinking… N tokens" / duration), expandable per message; never mixed into the answer text.

## 2. Context usage (spec 4)
Token counting (server, module `tokens.ts`): preferred = the exact `usage.prompt_tokens` of the latest completed assistant message on the current path (calibration), otherwise backend tokenizer when available (llama.cpp `POST {origin}/tokenize`, LM Studio none, Ollama none), otherwise an estimate: ASCII/Latin ~ chars/4, CJK/kana/hangul ~ chars/1.5 per char, plus 4 tokens per message overhead. Always report `estimated: boolean`.
- `GET /conversations/:id/context` -> `ContextUsage`; `POST /conversations/:id/context {draft?: string, providerId?: string, model?: string, effort?: Effort}` -> same, with the draft counted as `input` (used by the composer for live counting; debounced by the client; cheap, no model call).
```ts
interface ContextUsage {
  limit: number | null;                 // context window in tokens for the selected model; null = unknown
  limitSource: "backend" | "override" | "unknown";   // backend = adapter (LM Studio loaded_context_length/max_context_length, Ollama num_ctx/model info, llama.cpp /props n_ctx); override = settings
  total: number;                        // sum of used.*
  used: { system: number; history: number; attachments: number; tools: number; input: number };   // attachments/tools = 0 until phase 3
  reasoning: number;                    // thinking tokens of the history that are RE-sent (normally 0) — plus `lastReasoning` below
  lastReasoning: number;                // thinking tokens produced by the last reply (display only)
  estimated: boolean;
  reserve: number;                      // tokens kept free for the reply (maxTokens param or 1024)
  fits: boolean;                        // total + reserve <= limit (true when limit unknown)
  headId: string | null;
}
```
- Settings gains `contextOverflow: "truncate" | "summarize" | "stop"` (default `"truncate"`) and `contextLimits: Record<string, number> | null` (override per `"<providerId>::<model>"`). Both synced.
- Enforcement at send/regenerate (`buildContext`): if `limit` is known and `total + reserve > limit`: **truncate** = drop the oldest history messages (always keep the system message and the newest user message; drop whole user+assistant pairs from the start of the path) until it fits; **summarize** = replace the dropped pairs with ONE system-role note produced by a single extra non-streamed call to the same model ("Summarize this conversation so far in <=200 words"), cached per (conversation, dropped-range) and never persisted as a chat message; falls back to truncate on failure; **stop** = reject with WS `{type:"error", code:"context_overflow", message, messageId}` and leave no assistant message. The debug record notes what was dropped/summarized (`final.contextAction`).
- WS `send`/`regenerate` replies unchanged otherwise. The UI warns at >= 80 % of limit.

## 3. Speed metrics (spec 5)
- Table `metrics` (server, own migration file): `message_id PK, user_id, conversation_id, provider_id, provider_kind, model, quantization, context_length, prompt_tokens, completion_tokens, reasoning_tokens, ttft_ms, total_ms, prefill_tps, decode_tps, source ('backend'|'estimated'), created_at`.
- `Message` gains `metrics: Metrics | null` (same fields minus ids, camelCase) for assistant messages; included in sync/upsert once the reply finished (status done/stopped/error).
- Sources per backend (adapters, S4): **llama.cpp** response `timings` (`prompt_per_second`, `predicted_per_second`, `prompt_n`, `predicted_n`, `prompt_ms`, `predicted_ms`); **LM Studio** the `stats` object of its responses/`usage` when present (`tokens_per_second`, `time_to_first_token`), request `stream_options.include_usage` is already sent; **Ollama** OpenAI-compat gives only `usage` -> estimated; **others** estimated: `ttft_ms` measured from request start to the first text OR reasoning delta, `total_ms` to completion, `decode_tps = completion_tokens / ((total_ms - ttft_ms)/1000)`, `prefill_tps = prompt_tokens / (ttft_ms/1000)`; if token counts are missing, estimate with `tokens.ts` and mark `source:"estimated"`. Quantization and context length come from the model-management adapters when known (nullable).
- `GET /stats?since=<epoch ms>&recent=<N default 20>` -> `{overall:{count, avgTtftMs, avgPrefillTps, avgDecodeTps, avgCompletionTokens}, recent:{n, ...same averages}, byModel:[{providerId, providerName, model, quantization, contextLength, count, avgTtftMs, avgPrefillTps, avgDecodeTps}], series:[{t, model, decodeTps, prefillTps, ttftMs}]}` (series = the last up to 200 points, oldest first). Rows with `source:"estimated"` are included but averages also return `estimatedShare` (0..1) per group. Group by (provider, model, quantization, contextLength) so different conditions are comparable.
- `GET /stats/export` -> CSV of all metrics rows (owner only).

## 4. Latency and route (spec 6)
- WS: client sends `{type:"ping", t:<client ms>}`, server answers immediately `{type:"pong", t}` (echo). The `hello` frame gains `route: "loopback" | "lan" | "vpn" | "external"` and `serverTime`. Classification from the peer address (honour `TRUST_PROXY=1` -> first `X-Forwarded-For`): 127.0.0.0/8 & ::1 -> loopback; 10/8, 172.16/12, 192.168/16, fe80::/10, fc00::/7 -> lan; 100.64.0.0/10 (Tailscale CGNAT) -> vpn; else external. Also `GET /ping` already exists (HTTP fallback when WS is down).
- Client behaviour (specified for the app agent): ping every 5 s while connected, keep the last 6 RTTs, show the average in the header with colour (good < 150 ms, slow 150–500 ms, bad > 500 ms, disconnected) plus the route label; on disconnect retry with backoff (1,2,5,10,30 s) and keep the draft text and pending state; a manual "Reconnect now" action.

## 5. Streaming reconnect (spec "ストリーミングの再接続")
Server already continues generation without clients and sends `snapshot` on connect. Add: `snapshot` also carries `reasoning`, and a client that reconnects mid-stream replaces content AND reasoning with the snapshot, then continues appending deltas. The app must show the in-progress message after a reload/other device immediately (from snapshot) and offer Stop.

## 6. Ownership for implementation
Server (S4): chat.ts, providers/*, adapters/*, new tokens.ts, context.ts, metrics.ts, stats routes, hub/ws ping/pong + hello route, migrations (own file `migrate-metrics.ts`, one call line in db.ts), tests. App (A2): everything UI under app/src (context bar + breakdown popover, 80 % warning, overflow setting UI in Settings, per-message metrics line (TTFT, prefill/decode tok/s, tokens, 'est.' badge) and details in dev mode, stats screen (overall/recent/by model table + a simple line chart of decode tok/s over the series, all drawn without new heavy dependencies), latency indicator + route label in the header, collapsed thinking block, reconnect UX). Both must work against old servers (missing fields => hidden).

## 7. Implementation notes (server, S4) - deviations and details
- Routes: `GET|POST /conversations/:id/context`, `GET /stats`, `GET /stats/export` live in `routes-visibility.ts`. `POST` bodies `effort` is accepted but does not change the numbers.
- WS `error` frame for stop mode: `{type:"error", code:"context_overflow", message, messageId}`; the whole turn is rejected before anything is stored (the user message is not persisted either), also for `regenerate`.
- Calibration uses the latest of the last 3 assistant messages on the path whose stored request is byte-identical to the current prefix and whose `usage` was exact (`metrics.usage_exact`, extra column beyond the contract); later messages / a draft are estimated (`estimated:true`).
- Summarize reserves ~450 tokens for the note; if even the newest user message plus system do not fit, the request is still sent and `contextAction.unfit=true`. Summarize works for openai-compatible providers only (others fall back to truncate, `fellBack:true`).
- Metrics: `usage.completion_tokens_details.reasoning_tokens` is used when present, otherwise reasoning tokens are split by estimated text share. A stopped reply that already produced output keeps its metrics. `quantization`/`contextLength` are re-read from the adapter after the reply (a JIT-loaded LM Studio model only reports its real state then); loaded context beats max context.
- Observed: LM Studio (this version) does NOT put `stats` into streamed responses, so its metrics are `source:"estimated"` (usage tokens exact, times self-measured); the `stats` path is implemented and tested with a fake. ttft of a JIT-loaded model includes the load time.
- Test fake backends only record `POST .../chat/completions` bodies (adapter probes get 404).
