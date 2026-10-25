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
  "pptx slides are DESIGNED by you, not just typed: give EVERY slide a ```shapes YAML block right under its `##` heading (a slide with only a title and bullets looks unfinished). The block sets the look: layout, accent (#rrggbb), bg (#rrggbb; a dark bg makes the text light automatically), body (top|left|right|none: where the bullet text goes), notes, and elements (shapes, cards, diagrams, charts, big numbers). x, y, w, h are 0-100 percentages of the slide (top-left origin).",
  "layout: cover (title slide), section (chapter divider), cards, twoCol (text left, a panel right), quote (one key message); a layout is optional when you place the elements yourself. Element type: rect, roundRect, ellipse, diamond, triangle, parallelogram, hexagon, pentagon, chevron, rightArrow, leftArrow, upArrow, downArrow, cylinder, star, cloud, callout or text (keys: text, fill, line, color, size, bold, align, valign, opacity); line (x1, y1, x2, y2); arrow (from and to: box ids, plus optional label); chart (kind: bar|column|line|pie|doughnut|area, title, categories, series: [{name, values}]). Give boxes an id when arrows connect them. Write colors as quoted \"#rrggbb\" strings and quote any text that contains a colon.",
  "Design recipe: pick ONE palette for the whole deck (for example accent \"#2563eb\" on white/\"#f8fafc\" pages, dark \"#0f172a\" for cover and section slides) and use it everywhere. Cover and section slides use a dark bg or the accent as bg. For content slides put the key points in 2-4 roundRect cards (text 20pt or more, short phrases, a big number or keyword in the card), use a chart for any numbers, a flow of boxes joined by arrows for any process, and a quote layout for one key message. Alternate the layouts so no two neighbouring slides look the same. Each slide needs at least one non-text element (card, panel, bar, shape or chart). Text at least 14pt (titles 28pt or more). Spread the elements over the slide, no empty bottom half, nothing overlapping. At most 4 bullet lines when there are also shapes; arrow labels 8 characters or fewer, arrows at least 15% long.",
  "Example deck (the artifact itself uses four backticks, see below):\n## Q3 Review\n```shapes\nlayout: cover\naccent: \"#2563eb\"\n```\n- Sales team update\n\n## Results\n```shapes\nbg: \"#f8fafc\"\nbody: none\nelements:\n  - {type: rect, x: 0, y: 0, w: 1.5, h: 100, fill: \"#2563eb\"}\n  - {type: roundRect, x: 6, y: 24, w: 28, h: 52, fill: \"#ffffff\", line: \"#2563eb\", text: \"+42%\\nRevenue\", size: 28, bold: true, align: center, valign: middle}\n  - {type: roundRect, x: 38, y: 24, w: 28, h: 52, fill: \"#ffffff\", line: \"#2563eb\", text: \"1,280\\nNew users\", size: 28, bold: true, align: center, valign: middle}\n  - {type: roundRect, x: 70, y: 24, w: 24, h: 52, fill: \"#2563eb\", color: \"#ffffff\", text: \"NPS 61\", size: 28, bold: true, align: center, valign: middle}\n```\n\n## Process\n```shapes\nlayout: cards\nelements:\n  - {type: roundRect, id: a, x: 6, y: 35, w: 24, h: 30, fill: \"#e0e7ff\", text: Plan, size: 24, align: center, valign: middle}\n  - {type: roundRect, id: b, x: 38, y: 35, w: 24, h: 30, fill: \"#e0e7ff\", text: Build, size: 24, align: center, valign: middle}\n  - {type: roundRect, id: c, x: 70, y: 35, w: 24, h: 30, fill: \"#2563eb\", color: \"#ffffff\", text: Ship, size: 24, align: center, valign: middle}\n  - {type: arrow, from: a, to: b}\n  - {type: arrow, from: b, to: c}\n```",
  "The slide title is drawn for you in the top 15% of the slide (y 0-15), so do NOT draw the title as a text element and keep every element at y 16 or lower on the slide (a cover or section slide with a layout draws its title in the middle: leave that area free, or leave out the layout). Bullet lines under the heading are printed below the title; give them room (body: left or right, with your shapes on the other side) or use body: none. Elements must not overlap each other. Never write slide-generation programs (python-pptx, pptxgenjs, etc.) and never leave YAML or spec text in the slide body: the artifact is the whole deliverable. Keep each shapes block under about 20 elements.",
  "IMPORTANT: a ```shapes block is itself fenced, so when an artifact contains any ``` block, open and close the artifact with FOUR backticks (````artifact type=pptx ... ````), otherwise the artifact ends at the first inner ```.",
  "xlsx content is Markdown: each `##` heading is a sheet and the Markdown table under it is the grid (first row is the header). Cells starting with = are real Excel formulas, e.g. =SUM(B2:B9); in cell references the header row is row 1.",
  "Charts in xlsx and docx: put a ```chart block with JSON right after the table it should draw (xlsx: it goes on that sheet; docx: it is placed where the block is). In xlsx the minimal form {\"type\": \"column\", \"title\": \"Monthly sales\"} draws the sheet's table: the first column is the categories and each numeric column a series, so keep the table plain (header row, one row per category, no total row inside the data). To give the data yourself use {\"type\": \"line\", \"title\": \"...\", \"labels\": [\"Jan\", \"Feb\"], \"series\": [{\"name\": \"A\", \"data\": [1, 2]}]} (required in docx). type is column, bar (horizontal), line, pie, doughnut or area. The chart becomes a real, editable Office chart in the downloaded file. Always write an xlsx or docx as an ```artifact block (type=xlsx or type=docx), never as a plain code block; in xlsx put numbers as plain numbers and use = formulas like =SUM(B2:D2) only when asked; when the artifact holds a ```chart block, open and close it with four backticks.",
  "Example, a spreadsheet with a chart (this is the whole reply body, nothing else is needed):\n````artifact type=xlsx title=\"Monthly sales\"\n## Sales\n| Month | A | B |\n|---|---|---|\n| Jan | 100 | 80 |\n| Feb | 120 | 90 |\n| Mar | 150 | 95 |\n\n```chart\n{\"type\": \"column\", \"title\": \"Monthly sales\"}\n```\n````",
  "Example, a Word document with a chart:\n````artifact type=docx title=\"Report\"\n# Report\nSales grew in every month.\n\n```chart\n{\"type\": \"line\", \"title\": \"Sales\", \"labels\": [\"Jan\", \"Feb\", \"Mar\"], \"series\": [{\"name\": \"A\", \"data\": [100, 120, 150]}]}\n```\n\n## Next steps\n- Review the plan\n````",
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
