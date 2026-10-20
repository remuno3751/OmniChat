export interface WireToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
/** A message body part (OpenAI chat format). A plain string stays a string on the wire. */
export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** user messages with images (openai-compatible only): sent as the body `content` instead of the string. `content` keeps the text form for estimates and logs. */
  parts?: ContentPart[];
  /** the text the user typed, without attachment notes (used for the search query); not sent upstream */
  plain?: string;
  /** assistant messages of a tool round (openai-compatible only) */
  tool_calls?: WireToolCall[];
  /** tool result messages */
  tool_call_id?: string;
}
/** OpenAI function-tool definition. */
export interface ToolDef { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface ProviderConfig {
  kind: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}
/** Filled in by the provider while streaming; stored per message for the debug endpoint. */
export interface DebugSink {
  response: { status?: number | string; finishReason?: string | null; usage?: unknown; timings?: unknown; stats?: unknown; raw?: unknown; logprobs?: { content: unknown[]; truncated?: boolean } };
}
export interface StreamRequest {
  messages: ChatMessage[];
  model: string;
  signal: AbortSignal;
  /** OpenAI-style snake_case sampling body fields (temperature, top_p, top_k, min_p, repeat_penalty, seed, stop, max_tokens). */
  params?: Record<string, unknown>;
  /** Mapped effort: object merged into the body (openai-compatible) or a string (dsh-bridge). */
  effort?: Record<string, unknown> | string | null;
  debug?: DebugSink;
  /** Tools offered to the model (openai-compatible only; other kinds ignore it). */
  tools?: ToolDef[];
  /** OpenAI `response_format` body value (openai-compatible only; others ignore it). */
  responseFormat?: Record<string, unknown> | null;
  /** Merged into the request body last; may never override model/messages/stream/tools/stream_options/response_format. */
  extraBody?: Record<string, unknown> | null;
  context?: { userId: string; conversationId: string; providerId: string; userMessageId?: string; assistantMessageId?: string };
}
/** A plain string is answer text; the object form carries the lane. */
export interface StreamToolCall { id: string; name: string; arguments: string }
export type StreamItem = string | { kind: "reasoning" | "text"; text: string } | { kind: "tool_calls"; calls: StreamToolCall[] };
export interface ChatProvider {
  stream(req: StreamRequest): AsyncIterable<StreamItem>;
}

type ProviderFactory = (cfg: ProviderConfig) => ChatProvider;

// `var` (hoisted, no TDZ) so registration works even though the bottom import
// (openai-compatible.js) is evaluated before this module's body runs.
// eslint-disable-next-line no-var
var registry: Map<string, ProviderFactory> | undefined;

export function registerProvider(kind: string, factory: ProviderFactory): void {
  (registry ??= new Map()).set(kind, factory);
}

export function createProvider(cfg: ProviderConfig): ChatProvider {
  const factory = registry?.get(cfg.kind);
  if (!factory) {
    throw new Error(
      `Unknown provider kind "${cfg.kind}" (available: ${providerKinds().join(", ") || "none"})`,
    );
  }
  return factory(cfg);
}

export function providerKinds(): string[] {
  return [...(registry?.keys() ?? [])];
}

import "./openai-compatible.js";
import "./dsh-bridge.js";
