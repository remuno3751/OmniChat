import {
  registerProvider,
  type ChatMessage,
  type ChatProvider,
  type ProviderConfig,
  type StreamRequest,
  type StreamItem,
  type StreamToolCall,
} from "./index.js";
import { applyExtraBody } from "../structured.js";
import { maskSecrets } from "../logring.js";

export const LOGPROBS_CAP = 256 * 1024;
const lpBytes = new WeakMap<object, number>();

/** Messages with `parts` go out with the parts as `content`; all others (and a list without any) are sent exactly as they are. */
export function wireMessages(messages: ChatMessage[]): unknown[] {
  if (!messages.some((m) => m.parts)) return messages;
  return messages.map((m) => {
    if (!m.parts) return m;
    const { parts, ...rest } = m;
    return { ...rest, content: parts };
  });
}

/** Appends `choices[0].logprobs.content` entries to the debug sink until LOGPROBS_CAP bytes are reached. */
export function collectLogprobs(debug: { response: { logprobs?: { content: unknown[]; truncated?: boolean } } }, lp: unknown): void {
  const content = (lp as any)?.content;
  if (!Array.isArray(content) || !content.length) return;
  const r = debug.response;
  const store = (r.logprobs ??= { content: [] });
  if (store.truncated) return;
  let used = lpBytes.get(store) ?? 0;
  for (const e of content) {
    const n = Buffer.byteLength(JSON.stringify(e) ?? "", "utf8") + 1;
    if (used + n > LOGPROBS_CAP) { store.truncated = true; break; }
    store.content.push(e);
    used += n;
  }
  lpBytes.set(store, used);
}

/** Accumulates streamed `delta.tool_calls` fragments (by index) into complete calls. */
export class ToolCallAccumulator {
  private readonly slots = new Map<number, { id: string; name: string; args: string }>();
  add(data: string): void {
    try {
      const tcs = JSON.parse(data)?.choices?.[0]?.delta?.tool_calls;
      if (!Array.isArray(tcs)) return;
      for (const tc of tcs) {
        if (!tc || typeof tc !== "object") continue;
        const idx = typeof tc.index === "number" ? tc.index : this.slots.size;
        let slot = this.slots.get(idx);
        if (!slot) this.slots.set(idx, (slot = { id: "", name: "", args: "" }));
        if (typeof tc.id === "string" && tc.id) slot.id = tc.id;
        const fn = tc.function;
        if (fn && typeof fn.name === "string") slot.name += fn.name;
        if (fn && typeof fn.arguments === "string") slot.args += fn.arguments;
      }
    } catch { /* ignore */ }
  }
  calls(): StreamToolCall[] {
    return [...this.slots.entries()].sort((a, b) => a[0] - b[0]).filter(([, s]) => s.name)
      .map(([i, s]) => ({ id: s.id || `call_${i}_${Math.random().toString(36).slice(2, 8)}`, name: s.name, arguments: s.args }));
  }
}

/** Upstream text kept in a debug record: this provider's own key and base URL are masked, as are Authorization / key-looking values. */
export function scrubUpstream(text: string, cfg: { baseUrl: string; apiKey: string }): string {
  let out = maskSecrets(text);
  if (cfg.apiKey) out = out.split(cfg.apiKey).join("[key]");
  const base = cfg.baseUrl.replace(/\/+$/, "");
  if (base) out = out.split(base).join("[url]");
  return out;
}

/** Applies f to every string inside a parsed JSON value. */
function mapStrings(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === "string") return f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)]));
  return v;
}

/** Parses one SSE data payload into stream items (reasoning first, then answer text). Exported for tests. */
export function extractDelta(data: string, debug?: StreamRequest["debug"], scrub?: (s: string) => string): StreamItem[] {
  try {
    const obj = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }; finish_reason?: string | null; logprobs?: unknown }>;
      usage?: unknown;
      timings?: unknown;
      stats?: unknown;
    };
    if (debug && obj && typeof obj === "object") {
      const r = debug.response;
      r.raw = scrub ? mapStrings(obj, scrub) : obj;
      if (obj.usage) r.usage = obj.usage;
      if (obj.timings) r.timings = obj.timings;
      if (obj.stats) r.stats = obj.stats;
      const fr = obj.choices?.[0]?.finish_reason;
      if (typeof fr === "string") r.finishReason = fr;
      const lp = obj.choices?.[0]?.logprobs;
      if (lp) collectLogprobs(debug, lp);
    }
    const delta = obj?.choices?.[0]?.delta;
    const out: StreamItem[] = [];
    const reasoning = typeof delta?.reasoning_content === "string" && delta.reasoning_content
      ? delta.reasoning_content
      : typeof delta?.reasoning === "string" ? delta.reasoning : "";
    if (reasoning) out.push({ kind: "reasoning", text: reasoning });
    const content = delta?.content;
    if (typeof content === "string" && content.length > 0) out.push(content);
    return out;
  } catch {
    return [];
  }
}

class OpenAICompatibleProvider implements ChatProvider {
  constructor(private readonly cfg: ProviderConfig) {}

  async *stream(req: StreamRequest): AsyncIterable<StreamItem> {
    const url = `${this.cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    if (this.cfg.apiKey) headers["Authorization"] = `Bearer ${this.cfg.apiKey}`;

    const body: Record<string, unknown> = {
      model: req.model || this.cfg.model,
      messages: wireMessages(req.messages),
      stream: true,
      ...(req.tools && req.tools.length ? { tools: req.tools } : {}),
      stream_options: { include_usage: true },
      ...(req.params ?? {}),
      ...(req.effort && typeof req.effort === "object" ? req.effort : {}),
    };
    // fields owned by the server: params / effort must not clobber them either
    body.model = req.model || this.cfg.model;
    body.messages = wireMessages(req.messages);
    body.stream = true;
    body.stream_options = { include_usage: true };
    if (req.responseFormat) body.response_format = req.responseFormat;
    else delete body.response_format;
    applyExtraBody(body, req.extraBody);
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: req.signal });
    } catch (e) {
      // fetch can echo the URL (e.g. "Failed to parse URL from ..."): keep the owner's URL and key out of the message and debug record
      const err = new Error(scrubUpstream(e instanceof Error ? e.message : String(e), this.cfg));
      if (e instanceof Error) err.name = e.name;
      throw err;
    }

    if (req.debug) req.debug.response.status = res.status;
    let errBody: string | null = null;
    if (!res.ok) {
      try {
        errBody = await res.text();
      } catch {
        errBody = "";
      }
      // Some servers (LM Studio) accept only json_schema / text in response_format and answer 400 to json_object:
      // ask again once with a schema that allows any object, which gives the same JSON mode.
      if (res.status === 400 && (body.response_format as { type?: string } | undefined)?.type === "json_object" && /response_format/i.test(errBody)) {
        body.response_format = { type: "json_schema", json_schema: { name: "json_object", schema: { type: "object" } } };
        try {
          res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: req.signal });
        } catch (e) {
          const err = new Error(scrubUpstream(e instanceof Error ? e.message : String(e), this.cfg));
          if (e instanceof Error) err.name = e.name;
          throw err;
        }
        if (req.debug) req.debug.response.status = res.status;
        errBody = res.ok ? null : await res.text().catch(() => "");
      }
    }
    if (!res.ok) {
      const body = errBody ?? "";
      const scrubbed = scrubUpstream(body, this.cfg);
      const snippet = scrubbed.slice(0, 300);
      if (req.debug) req.debug.response.raw = scrubbed.slice(0, 4000);
      throw new Error(
        `HTTP ${res.status}${res.statusText ? " " + res.statusText : ""}${snippet ? ": " + snippet : ""}`,
      );
    }
    if (!res.body) throw new Error("Response has no body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let done = false;
    const acc = new ToolCallAccumulator();

    // Returns the items of a complete line; sets done on [DONE].
    const handleLine = (rawLine: string): StreamItem[] => {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line.startsWith("data:")) return [];
      const data = line.slice(5).trim();
      if (!data) return [];
      if (data === "[DONE]") {
        done = true;
        return [];
      }
      acc.add(data);
      return extractDelta(data, req.debug, (t) => scrubUpstream(t, this.cfg));
    };

    try {
      while (!done) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while (!done && (idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          for (const it of handleLine(line)) yield it;
        }
      }
      if (!done) {
        buf += decoder.decode();
        if (buf) {
          for (const it of handleLine(buf)) yield it;
        }
      }
      const calls = acc.calls();
      if (calls.length) yield { kind: "tool_calls", calls };
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }
  }
}

registerProvider("openai-compatible", (cfg) => new OpenAICompatibleProvider(cfg));
