/*
 * Pure Markdown -> HTML renderer for the VS Code chat webview. No DOM, no vscode import, so it is unit-testable in node.
 *
 * Security model: model text is untrusted. The output is built ONLY from escaped text and fixed tags/classes.
 * Every attribute value is escaped, links pass through safeUrl(), and images never become <img> (the webview CSP
 * forbids remote images). Block/inline structure comes from the app's own parser (markdownParse.ts), so the
 * extension renders the same way the OmniChat app does.
 */
import { parseBlocks, parseInline } from "@app/components/markdownParse";
import type { Align, Block, Inline } from "@app/components/markdownParse";
import { tokenize } from "@app/components/highlight";
import type { Token } from "@app/components/highlight";

export interface RenderOptions {
  streaming?: boolean;
  copyLabel: string;
  maxHighlightLines?: number;
}

const DEFAULT_MAX_HIGHLIGHT_LINES = 600;
/** Above this many characters the rest is shown as escaped plain text (the markdown parser must never block the UI). */
export const MAX_MARKDOWN_CHARS = 60_000;
const CODE_LABEL_MAX = 32;
const SAFE_SCHEMES = new Set<string>(["http:", "https:", "vscode:"]);
const ALIGNS = new Set<string>(["left", "center", "right"]);
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escapes the five HTML-significant characters. Safe for text nodes and quoted attribute values. */
export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
}

/**
 * Returns the URL unchanged (trimmed) when its scheme is http, https or vscode. Anything else (relative URLs,
 * javascript:, data:, file:, blob:, or a scheme hidden behind whitespace or control characters) returns null.
 */
export function safeUrl(url: string): string | null {
  if (typeof url !== "string") return null;
  const t = url.trim();
  const colon = t.indexOf(":");
  if (colon <= 0) return null;
  const head = t.slice(0, colon);
  // Whitespace or control characters inside the scheme are an obfuscation attempt ("java\tscript:"), so reject.
  if (/[\u0000- \u007f-\u009f]/.test(head)) return null;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*$/.test(head)) return null;
  return SAFE_SCHEMES.has(head.toLowerCase() + ":") ? t : null;
}

/** Renders model Markdown to an HTML string. Never throws; falls back to escaped paragraph text. */
export function renderMarkdown(text: string, opts: RenderOptions): string {
  const full = String(text ?? "");
  if (!full) return "";
  if (full.length > MAX_MARKDOWN_CHARS) {
    const head = renderMarkdown(full.slice(0, MAX_MARKDOWN_CHARS), opts);
    return head + `<pre class="oc-md-raw">${escapeHtml(full.slice(MAX_MARKDOWN_CHARS))}</pre>`;
  }
  const source = full;
  try {
    const lines = source.replace(/\r\n?/g, "\n").split("\n");
    const blocks = parseBlocks(lines, !!opts.streaming);
    const ctx: Ctx = {
      copyLabel: String(opts.copyLabel ?? ""),
      maxHighlightLines: opts.maxHighlightLines ?? DEFAULT_MAX_HIGHLIGHT_LINES,
    };
    return renderBlocks(blocks, ctx);
  } catch {
    return `<p>${escapeHtml(source)}</p>`;
  }
}

interface Ctx {
  copyLabel: string;
  maxHighlightLines: number;
}

function renderBlocks(blocks: Block[], ctx: Ctx): string {
  let out = "";
  for (const b of blocks) out += renderBlock(b, ctx);
  return out;
}

function renderBlock(b: Block, ctx: Ctx): string {
  switch (b.k) {
    case "p":
      return `<p>${inlineHtml(parseInline(b.text))}</p>`;
    case "raw":
      return `<pre class="oc-md-raw">${escapeHtml(b.text)}</pre>`;
    case "h": {
      const level = Math.min(6, Math.max(1, Math.trunc(b.level) || 1));
      return `<h3 class="oc-md-h oc-md-h${level}">${inlineHtml(parseInline(b.text))}</h3>`;
    }
    case "code":
      return renderCode(b.lang, b.body, ctx);
    case "quote":
      return `<blockquote>${renderBlocks(b.children, ctx)}</blockquote>`;
    case "list":
      return renderList(b, ctx);
    case "table":
      return renderTable(b.align, b.head, b.rows);
    case "hr":
      return "<hr>";
    case "img":
      return `<p>${imageHtml(b.alt, b.url)}</p>`;
    default:
      return "";
  }
}

function renderList(b: Extract<Block, { k: "list" }>, ctx: Ctx): string {
  const tag = b.ordered ? "ol" : "ul";
  const start = b.ordered && Number.isFinite(b.start) && b.start !== 1
    ? ` start="${Math.trunc(b.start)}"`
    : "";
  let out = `<${tag}${start}>`;
  for (const item of b.items) {
    let check = "";
    if (item.task !== null) {
      const on = item.task === true;
      check = `<span class="oc-md-check${on ? " oc-md-check--on" : ""}" role="checkbox" aria-checked="${on ? "true" : "false"}" aria-disabled="true">${on ? "&#10003;" : ""}</span>`;
    }
    out += `<li${item.task !== null ? ' class="oc-md-task"' : ""}>${check}${renderBlocks(item.children, ctx)}</li>`;
  }
  return out + `</${tag}>`;
}

function renderTable(align: Align[], head: string[], rows: string[][]): string {
  const cls = (i: number) => {
    const a = align[i];
    return `oc-md-al-${a && ALIGNS.has(a) ? a : "left"}`;
  };
  let out = '<div class="oc-md-table"><table><thead><tr>';
  head.forEach((cell, i) => {
    out += `<th class="${cls(i)}">${inlineHtml(parseInline(cell))}</th>`;
  });
  out += "</tr></thead><tbody>";
  for (const row of rows) {
    out += "<tr>";
    head.forEach((_, i) => {
      out += `<td class="${cls(i)}">${inlineHtml(parseInline(row[i] ?? ""))}</td>`;
    });
    out += "</tr>";
  }
  return out + "</tbody></table></div>";
}

function renderCode(rawLang: string, body: string, ctx: Ctx): string {
  const label = (String(rawLang ?? "").trim().slice(0, CODE_LABEL_MAX)) || "text";
  const src = String(body ?? "");
  const lineCount = src.split("\n").length;
  let inner: string;
  if (lineCount > ctx.maxHighlightLines) {
    inner = escapeHtml(src);
  } else {
    inner = tokensHtml(safeTokenize(src, rawLang));
  }
  return (
    `<div class="oc-code"><div class="oc-code__bar">` +
    `<span class="oc-code__lang">${escapeHtml(label)}</span>` +
    `<button type="button" class="oc-code__copy" data-oc-copy>${escapeHtml(ctx.copyLabel)}</button>` +
    `</div><pre class="oc-code__pre"><code>${inner}</code></pre></div>`
  );
}

/** Tokenizer failures degrade to plain text rather than breaking the whole message. */
function safeTokenize(src: string, lang: string): Token[] {
  try {
    return tokenize(src, lang);
  } catch {
    return [{ text: src, kind: "plain" }];
  }
}

function tokensHtml(tokens: Token[]): string {
  let out = "";
  for (const t of tokens) {
    const text = escapeHtml(t.text);
    out += t.kind === "plain" ? text : `<span class="oc-tk oc-tk--${t.kind}">${text}</span>`;
  }
  return out;
}

function inlineHtml(items: Inline[]): string {
  let out = "";
  for (const it of items) {
    if (typeof it === "string") {
      out += escapeHtml(it).replace(/\n/g, "<br>");
      continue;
    }
    if (!it || typeof it !== "object") continue;
    switch (it.type) {
      case "code":
        out += `<code class="oc-md-code">${escapeHtml(it.text)}</code>`;
        break;
      case "bold":
        out += `<strong>${inlineHtml(it.children)}</strong>`;
        break;
      case "italic":
        out += `<em>${inlineHtml(it.children)}</em>`;
        break;
      case "strike":
        out += `<del>${inlineHtml(it.children)}</del>`;
        break;
      case "link": {
        const href = safeUrl(it.url);
        if (href === null) {
          out += escapeHtml(plainText(it.children));
        } else {
          out += `<a class="oc-md-link" href="${escapeHtml(href)}" rel="noopener noreferrer">${inlineHtml(it.children)}</a>`;
        }
        break;
      }
      case "image":
        out += imageHtml(it.alt, it.url);
        break;
      default:
        break;
    }
  }
  return out;
}

/** Images are shown as links (or plain alt text), never as <img>. */
function imageHtml(alt: string, url: string): string {
  const label = escapeHtml(`\u{1F5BC} ${alt || "image"}`);
  const href = safeUrl(url);
  if (href === null) return escapeHtml(alt || "image");
  return `<a class="oc-md-link" href="${escapeHtml(href)}" rel="noopener noreferrer">${label}</a>`;
}

function plainText(items: Inline[]): string {
  let out = "";
  for (const it of items) {
    if (typeof it === "string") out += it;
    else if (!it || typeof it !== "object") continue;
    else if (it.type === "code") out += it.text;
    else if (it.type === "image") out += it.alt;
    else if (it.type === "link" || it.type === "bold" || it.type === "italic" || it.type === "strike") {
      out += plainText(it.children);
    }
  }
  return out;
}
