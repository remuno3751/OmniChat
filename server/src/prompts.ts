import type { Effort, SamplingParams } from "./db.js";
import { getProviderRow } from "./db.js";
import type { ChatMessage } from "./providers/index.js";
import { getProjectRow, getSettings } from "./projects.js";
import { pathRows } from "./branching.js";
import { mergeParams, sanitizeParams, sanitizeEffort } from "./sampling.js";
import { effortSupport, mapEffort } from "./effort.js";
import { estimateTokens, MSG_OVERHEAD } from "./tokens.js";

export interface PromptPiece { text: string | null | undefined; mode?: "append" | "replace" }

/** System prompt hierarchy (global -> project -> conversation). Empty pieces are skipped; "replace" discards what is above. */
export function composeSystemPrompt(global: string | null | undefined, ...pieces: PromptPiece[]): string | null {
  let acc = (global ?? "").trim();
  for (const p of pieces) {
    const t = (p.text ?? "").trim();
    if (!t) continue;
    acc = p.mode === "replace" || !acc ? t : `${acc}\n\n${t}`;
  }
  return acc || null;
}

/** Tells the model what "now" is; models otherwise guess from their training cutoff and call today's date "future". */
export function currentDateBlock(now = new Date()): string {
  const tz = process.env.OMNICHAT_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, ...o });
  const parts = Object.fromEntries(fmt({ year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "long", timeZoneName: "short" }).formatToParts(now).map((p) => [p.type, p.value]));
  const hh = parts.hour === "24" ? "00" : parts.hour;
  const day = (offset: number) => fmt({ year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now.getTime() + offset * 86_400_000));
  return `Current date and time: ${parts.year}-${parts.month}-${parts.day} (${parts.weekday}) ${hh}:${parts.minute} ${parts.timeZoneName} [${tz}]. Yesterday was ${day(-1)} and tomorrow is ${day(1)}. This is the real present and is later than your training data, so any date up to and including today is NOT in the future. Resolve "today", "yesterday", "tomorrow", "this week" and similar words against this date. Your own knowledge may be out of date: if the user mentions a product, event, price or version you do not recognise, do not claim it does not exist or has not been released; say it may be newer than your knowledge. Never refuse a question by saying you lack real-time data without first using any search results provided.`;
}

/** Phase 5: tells the model which rich blocks the app renders. Off together with the date block (OMNICHAT_INJECT_DATE=0). */
export const RICH_CONTENT_NOTE = [
  "Formatting: you may use Markdown (headings, lists, tables, bold, code blocks) in your replies.",
  "For a chart, use a ```chart code block containing JSON: {\"type\": \"line\" | \"bar\" | \"pie\", \"title\": \"...\", \"labels\": [\"...\"], \"series\": [{\"name\": \"...\", \"data\": [numbers]}]}.",
  "For a long standalone document the user may want to keep or download, use an ```artifact block: the info string is `artifact type=markdown|html|docx|pptx|xlsx|email title=\"...\"` (type defaults to markdown). docx and pptx content is Markdown (for pptx each `##` heading starts a slide).",
  "In pptx content, a diagram or chart goes in a ```shapes YAML block under the slide heading (instead of plain bullets). Keys: optional bg (#rrggbb), body (top|left|right|none: where the slide's bullet text goes), notes, and elements. Positions x, y, w, h are 0-100 percentages of the slide (top-left origin).",
  "Element type: rect, roundRect, ellipse, diamond, triangle, parallelogram, hexagon, pentagon, chevron, rightArrow, leftArrow, upArrow, downArrow, cylinder, star, cloud, callout or text (with text, fill, color, size, align); line (x1, y1, x2, y2); arrow (from and to: ids of boxes, plus optional label); chart (kind: bar|column|line|pie|doughnut|area, title, categories, series: [{name, values}]).",
  "Give boxes an id when arrows connect them. Keep each slide to about 15 elements, and keep shapes clear of the body text area.",
  "IMPORTANT: a ```shapes block is itself fenced, so when an artifact contains any ``` block, open and close the artifact with FOUR backticks (````artifact type=pptx ... ````), otherwise the artifact ends at the first inner ```.",
  "xlsx content is Markdown: each `##` heading is a sheet and the Markdown table under it is the grid (first row is the header). Cells starting with = are real Excel formulas, e.g. =SUM(B2:B9); in cell references the header row is row 1.",
  "email content is header lines (To:, Cc:, Subject:, only those needed), then a blank line, then the body. When the user pastes a received email and asks for a reply, write it as an `artifact type=email` block in the email's language unless told otherwise, keep the requested tone, and never invent facts (dates, amounts, names, commitments). Mark missing information as [要確認: ...] and briefly mention those gaps in the chat text outside the block.",
  "When the user provides an existing document and asks for changes, re-emit the full updated artifact.",
].join("\n");

export interface ContextInput {
  userId: string;
  conv: any; // conversations row
  /** Last message of the history (the new user message, or the user message being answered). */
  leafId: string | null;
  model: string;
  providerKind: string;
  /** enables the per-model params layer (settings.modelParams["<providerId>::<model>"]) */
  providerId?: string | null;
  oneShot?: { params?: unknown; effort?: unknown };
}

export interface HistoryItem { id: string; role: "user" | "assistant"; content: string }
export interface BuiltContext {
  messages: ChatMessage[];
  /** Composed system prompt (null = none) and the history items (root -> leaf) that follow it in `messages`. */
  system: string | null;
  history: HistoryItem[];
  params: SamplingParams;
  effort: { requested: Effort | null; resolved: Effort | null; sentAs: unknown };
  /** /compact: tokens of the persisted summary folded into `system` (0 or undefined when no compaction applies). */
  compactedTokens?: number;
}

/** Same label the automatic compression note uses (context.ts). */
export const SUMMARY_LABEL = "[Summary of the earlier conversation]";

const firstEffort = (...vals: unknown[]): Effort | null => {
  for (const v of vals) {
    const e = sanitizeEffort(v);
    if (e) return e;
  }
  return null;
};

export function buildContext(input: ContextInput): BuiltContext {
  const { userId, conv } = input;
  const settings = getSettings(userId);
  const pr = conv.project_id ? getProjectRow(conv.project_id) : undefined;
  const project = pr && pr.user_id === userId && !pr.deleted ? pr : undefined;

  const system = composeSystemPrompt(
    settings.systemPrompt,
    { text: project?.system_prompt, mode: project?.system_mode === "replace" ? "replace" : "append" },
    { text: conv.system_prompt, mode: conv.system_mode === "replace" ? "replace" : "append" },
  );

  let history: HistoryItem[] = pathRows(conv.id, input.leafId)
    .filter((r) => (r.status === "done" || r.status === "stopped") && r.content !== "")
    .map((r) => ({ id: r.id, role: r.role, content: r.content }));
  // /compact: a stored summary covers the path up to compact_upto. Ignored when that message is not on this path.
  let summary: string | null = null;
  let compactedTokens: number | undefined;
  if (conv.compact_summary && conv.compact_upto) {
    const at = history.findIndex((h) => h.id === conv.compact_upto);
    if (at >= 0) {
      history = history.slice(at + 1);
      summary = String(conv.compact_summary);
      compactedTokens = estimateTokens(summary) + MSG_OVERHEAD;
    }
  }
  const base = process.env.OMNICHAT_INJECT_DATE === "0" ? system : [system, currentDateBlock(), RICH_CONTENT_NOTE].filter(Boolean).join("\n\n");
  const dated = summary ? [base, `${SUMMARY_LABEL}\n${summary}`].filter(Boolean).join("\n\n") : base;
  const messages: ChatMessage[] = [
    ...(dated ? [{ role: "system" as const, content: dated }] : []),
    ...history.map((h) => ({ role: h.role, content: h.content })),
  ];

  let convParams: SamplingParams | null = null;
  let projParams: SamplingParams | null = null;
  try { convParams = conv.params ? sanitizeParams(JSON.parse(conv.params)) : null; } catch { /* ignore */ }
  try { projParams = project?.params ? sanitizeParams(JSON.parse(project.params)) : null; } catch { /* ignore */ }
  // one-shot > conversation > project > settings.modelParams[<providerId>::<model>] > global
  const modelParams = input.providerId ? settings.modelParams?.[`${input.providerId}::${input.model}`] ?? null : null;
  const params = mergeParams(sanitizeParams(input.oneShot?.params), convParams, projParams, modelParams, settings.params);

  const requested = firstEffort(input.oneShot?.effort, conv.effort, project?.effort, settings.effort);
  const resolved = requested && effortSupport(input.model) !== "unsupported" ? requested : null;
  // the provider row's effort_profile (null = standard); read here so callers keep their signature
  const profile = input.providerId ? (getProviderRow(input.providerId)?.effort_profile ?? null) : null;
  const sentAs = resolved ? mapEffort(input.providerKind, resolved, profile) : null;

  return { messages, system: dated, history, params, effort: { requested, resolved, sentAs }, ...(compactedTokens ? { compactedTokens } : {}) };
}
