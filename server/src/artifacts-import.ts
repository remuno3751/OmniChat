import type { FastifyInstance } from "fastify";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { authFromRequest, AuthError } from "./auth.js";

/* Import: a file (base64 in JSON) -> Markdown content for the artifact panel. Pure parsers, no I/O besides the request. */

export type ImportedType = "markdown" | "docx" | "xlsx" | "pptx" | "email";
export interface ImportResult { type: ImportedType; title: string; content: string }

const MAX_BYTES = 5_000_000;
const IMPORT_BODY_LIMIT = 8_000_000;
const MAX_ROWS = 5000;
const MAX_COLS = 100;

const bad = (m: string, status = 400) => new AuthError(m, status);

type Kind = "markdown" | "docx" | "xlsx" | "pptx" | "email" | "csv";
const KINDS: Record<string, { kind: Kind; type: ImportedType }> = {
  docx: { kind: "docx", type: "docx" },
  xlsx: { kind: "xlsx", type: "xlsx" },
  pptx: { kind: "pptx", type: "pptx" },
  eml: { kind: "email", type: "email" },
  md: { kind: "markdown", type: "markdown" },
  markdown: { kind: "markdown", type: "markdown" },
  txt: { kind: "markdown", type: "markdown" },
  csv: { kind: "csv", type: "xlsx" },
};

/** Filename -> display title (no directory, no extension, no control characters, <= 100 chars). */
function fileTitle(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const stem = dot >= 0 ? base.slice(0, dot) : base;
  const t = stem.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  return t || "Untitled";
}

/** Converts a file to artifact content. Throws AuthError 415 (unsupported type), 413 (too large) or 422 (unreadable file). */
export async function importDocument(filename: string, data: Buffer): Promise<ImportResult> {
  const base = (filename ?? "").split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
  const spec = KINDS[ext];
  if (!spec) throw bad("This file type is not supported", 415);
  if (data.length > MAX_BYTES) throw bad("The file is larger than 5 MB", 413);
  const title = fileTitle(base);
  let content: string;
  try {
    content = await convert(spec.kind, data);
  } catch (e) {
    if (e instanceof AuthError) throw e;
    throw bad("The file could not be read", 422);
  }
  return { type: spec.type, title, content };
}

async function convert(kind: Kind, data: Buffer): Promise<string> {
  switch (kind) {
    case "markdown": return decodeText(data).replace(/\r\n?/g, "\n").trim();
    case "docx": return docxToMarkdown(data);
    case "xlsx": return xlsxToMarkdown(data);
    case "pptx": return pptxToMarkdown(data);
    case "csv": return csvToMarkdown(data);
    case "email": return emlToContent(data);
  }
}

/* ---------------- shared helpers ---------------- */

/** Table cell text: single line, no pipes (they would end the cell). */
function cleanCell(s: string): string {
  return s.replace(/\|/g, "/").replace(/\s+/g, " ").trim();
}

/** Markdown table from rows; the first row is the header. */
function mdTable(rows: string[][]): string {
  const width = Math.max(1, ...rows.map((r) => r.length));
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  const [head, ...body] = rows;
  return [line(head ?? []), `| ${Array(width).fill("---").join(" | ")} |`, ...body.map(line)].join("\n");
}

/** One `## Name` sheet with its grid (rows beyond the caps are dropped, trailing empty rows removed). */
function sheetMarkdown(name: string, rows: string[][]): string {
  const clipped = rows.slice(0, MAX_ROWS).map((r) => r.slice(0, MAX_COLS).map(cleanCell));
  while (clipped.length && clipped[clipped.length - 1].every((c) => c === "")) clipped.pop();
  const head = `## ${cleanCell(name) || "Sheet"}`;
  return clipped.length ? `${head}\n\n${mdTable(clipped)}` : head;
}

function decodeText(data: Buffer): string {
  return new TextDecoder("utf-8").decode(data);
}

const ENTITIES = new Map<string, string>([["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", "\""], ["apos", "'"], ["nbsp", " "]]);
function unescapeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES.get(e) ?? m;
  });
}

/* ---------------- minimal XML tree (for docx / pptx) ---------------- */

interface XNode { name: string; attrs: Record<string, string>; kids: (XNode | string)[] }

const XML_TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const XML_ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseXml(xml: string): XNode {
  const root: XNode = { name: "#root", attrs: {}, kids: [] };
  const stack: XNode[] = [root];
  XML_TOKEN.lastIndex = 0;
  for (let m = XML_TOKEN.exec(xml); m; m = XML_TOKEN.exec(xml)) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) { top.kids.push(m[1]); continue; }
    if (m[2] !== undefined) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === m[2]) { stack.length = i; break; }
      }
      continue;
    }
    if (m[3] !== undefined) {
      const attrs: Record<string, string> = {};
      for (const a of (m[4] ?? "").matchAll(XML_ATTR)) attrs[a[1]] = unescapeEntities(a[2] ?? a[3] ?? "");
      const node: XNode = { name: m[3], attrs, kids: [] };
      top.kids.push(node);
      if (m[5] !== "/") stack.push(node);
      continue;
    }
    if (m[6] !== undefined) top.kids.push(unescapeEntities(m[6]));
  }
  return root;
}

const elems = (n: XNode | undefined, name?: string): XNode[] =>
  n ? (n.kids.filter((k) => typeof k !== "string" && (name === undefined || k.name === name)) as XNode[]) : [];
const child = (n: XNode | undefined, name: string): XNode | undefined => elems(n, name)[0];
const attrOf = (n: XNode | undefined, name: string): string | undefined => n?.attrs[name];
const findAll = (n: XNode, name: string, out: XNode[] = []): XNode[] => {
  for (const k of elems(n)) {
    if (k.name === name) out.push(k);
    findAll(k, name, out);
  }
  return out;
};

/* ---------------- DOCX ---------------- */

interface Seg { text: string; b: boolean; i: boolean }

const onOff = (rPr: XNode | undefined, name: string): boolean => {
  const el = child(rPr, name);
  if (!el) return false;
  const v = attrOf(el, "w:val");
  return !(v === "0" || v === "false" || v === "off");
};

/** Text runs of a paragraph (hyperlinks and insertions are descended into). */
function segsOf(node: XNode, out: Seg[] = []): Seg[] {
  for (const k of elems(node)) {
    if (k.name === "w:r") {
      const rPr = child(k, "w:rPr");
      const b = onOff(rPr, "w:b");
      const i = onOff(rPr, "w:i");
      let text = "";
      for (const c of k.kids) {
        if (typeof c === "string") continue;
        if (c.name === "w:t") text += c.kids.map((x) => (typeof x === "string" ? x : "")).join("");
        else if (c.name === "w:tab") text += " ";
        else if (c.name === "w:br" || c.name === "w:cr") text += " ";
        else if (c.name === "w:noBreakHyphen") text += "-";
      }
      if (text) out.push({ text, b, i });
    } else if (["w:hyperlink", "w:ins", "w:smartTag", "w:customXml", "w:fldSimple"].includes(k.name)) {
      segsOf(k, out);
    } else if (k.name === "w:sdt") {
      segsOf(child(k, "w:sdtContent") ?? { name: "", attrs: {}, kids: [] }, out);
    }
  }
  return out;
}

/** Inline Markdown from runs: adjacent runs with the same emphasis are merged; markers stay outside whitespace. */
function renderSegs(segs: Seg[]): string {
  const merged: Seg[] = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && last.b === s.b && last.i === s.i) last.text += s.text;
    else merged.push({ ...s });
  }
  return merged.map((s) => {
    if (!s.text.trim()) return s.text;
    const lead = /^\s*/.exec(s.text)![0];
    const trail = /\s*$/.exec(s.text)![0];
    let core = s.text.slice(lead.length, s.text.length - trail.length);
    if (s.i) core = `*${core}*`;
    if (s.b) core = `**${core}**`;
    return lead + core + trail;
  }).join("");
}

interface Numbering { isOrdered(numId: string, ilvl: number): boolean }

function parseNumbering(xml: string | undefined): Numbering {
  const abstractFmt = new Map<string, Map<number, string>>();
  const numToAbstract = new Map<string, string>();
  if (xml) {
    const root = parseXml(xml);
    for (const an of findAll(root, "w:abstractNum")) {
      const levels = new Map<number, string>();
      for (const lvl of elems(an, "w:lvl")) {
        const fmt = attrOf(child(lvl, "w:numFmt"), "w:val");
        if (fmt) levels.set(Number(attrOf(lvl, "w:ilvl") ?? 0), fmt);
      }
      abstractFmt.set(attrOf(an, "w:abstractNumId") ?? "", levels);
    }
    for (const num of findAll(root, "w:num")) {
      const abs = attrOf(child(num, "w:abstractNumId"), "w:val");
      if (abs !== undefined) numToAbstract.set(attrOf(num, "w:numId") ?? "", abs);
    }
  }
  return {
    isOrdered(numId, ilvl) {
      const abs = numToAbstract.get(numId);
      const fmt = abs === undefined ? undefined : abstractFmt.get(abs)?.get(ilvl);
      return fmt !== undefined && fmt !== "bullet" && fmt !== "none";
    },
  };
}

/** One paragraph as a Markdown block ("" when empty). List items are returned with a marker and flagged. */
function paragraphMd(p: XNode, numbering: Numbering): { text: string; item: boolean } {
  const pPr = child(p, "w:pPr");
  const style = attrOf(child(pPr, "w:pStyle"), "w:val") ?? "";
  const segs = segsOf(p);
  const plain = segs.map((s) => s.text).join("").replace(/\s+/g, " ").trim();
  if (!plain) return { text: "", item: false };
  const heading = /^heading\s*([1-6])$/i.exec(style);
  if (heading) return { text: `${"#".repeat(Number(heading[1]))} ${plain}`, item: false };
  if (/^title$/i.test(style)) return { text: `# ${plain}`, item: false };
  const body = renderSegs(segs).replace(/\s+/g, " ").trim();
  const numPr = child(pPr, "w:numPr");
  let numId: string | undefined;
  let ilvl = 0;
  let ordered = false;
  if (numPr) {
    numId = attrOf(child(numPr, "w:numId"), "w:val");
    ilvl = Number(attrOf(child(numPr, "w:ilvl"), "w:val") ?? 0) || 0;
    if (numId === "0") numId = undefined;
    else if (numId !== undefined) ordered = numbering.isOrdered(numId, ilvl);
  }
  if (numId === undefined && !numPr) {
    if (/^ListNumber/i.test(style)) { ordered = true; numId = "style"; }
    else if (/^ListBullet/i.test(style)) numId = "style";
  }
  if (numId !== undefined) return { text: `${"  ".repeat(ilvl)}${ordered ? "1." : "-"} ${body}`, item: true };
  return { text: body, item: false };
}

function tableMarkdown(tbl: XNode, numbering: Numbering): string {
  const rows: string[][] = [];
  for (const tr of elems(tbl, "w:tr")) {
    const cells: string[] = [];
    for (const tc of elems(tr, "w:tc")) {
      const span = Math.max(1, Number(attrOf(child(child(tc, "w:tcPr"), "w:gridSpan"), "w:val")) || 1);
      const text = elems(tc, "w:p")
        .map((p) => renderSegs(segsOf(p)))
        .filter((t) => t.trim())
        .join(" ");
      cells.push(cleanCell(text));
      for (let k = 1; k < span; k++) cells.push("");
    }
    rows.push(cells);
  }
  return rows.length ? mdTable(rows) : "";
}

async function docxToMarkdown(data: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(data);
  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("no word/document.xml");
  const numFile = zip.file("word/numbering.xml");
  const numbering = parseNumbering(numFile ? await numFile.async("string") : undefined);
  const root = parseXml((await docFile.async("string")).replace(/^﻿/, ""));
  const body = findAll(root, "w:body")[0];
  if (!body) throw new Error("no w:body");

  const blocks: { text: string; item: boolean }[] = [];
  const visit = (node: XNode) => {
    for (const k of elems(node)) {
      if (k.name === "w:p") {
        const r = paragraphMd(k, numbering);
        if (r.text) blocks.push(r);
      } else if (k.name === "w:tbl") {
        const t = tableMarkdown(k, numbering);
        if (t) blocks.push({ text: t, item: false });
      } else if (k.name === "w:sdt") {
        visit(child(k, "w:sdtContent") ?? { name: "", attrs: {}, kids: [] });
      }
    }
  };
  visit(body);

  let out = "";
  blocks.forEach((b, idx) => {
    if (idx > 0) out += blocks[idx - 1].item && b.item ? "\n" : "\n\n";
    out += b.text;
  });
  return out.trim();
}

/* ---------------- XLSX / CSV ---------------- */

function xlCell(v: any): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return "";
    const iso = v.toISOString();
    return iso.slice(0, 10) + (iso.slice(11, 19) === "00:00:00" ? "" : ` ${iso.slice(11, 16)}`);
  }
  if (typeof v === "object") {
    const f = v.formula ?? v.sharedFormula;
    if (typeof f === "string") return `=${f.replace(/^=/, "")}`;
    if (Array.isArray(v.richText)) return v.richText.map((r: any) => r.text ?? "").join("");
    if (typeof v.text === "string") return v.text;
    if (typeof v.error === "string") return v.error;
    if ("result" in v) return xlCell(v.result);
  }
  return String(v);
}

async function xlsxToMarkdown(data: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as any);
  const sections: string[] = [];
  wb.eachSheet((ws) => {
    const rows: string[][] = [];
    const lastRow = Math.min(ws.rowCount, MAX_ROWS);
    const lastCol = Math.min(ws.columnCount, MAX_COLS);
    for (let r = 1; r <= lastRow; r++) {
      const row = ws.getRow(r);
      const cells: string[] = [];
      for (let c = 1; c <= lastCol; c++) cells.push(xlCell(row.getCell(c).value));
      rows.push(cells);
    }
    sections.push(sheetMarkdown(ws.name, rows));
  });
  return sections.join("\n\n");
}

/** RFC 4180 parser: quoted fields with "" escapes, CRLF or LF inside quotes, blank lines dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === "\"") {
        if (text[i + 1] === "\"") { field += "\""; i++; } else quoted = false;
      } else field += c;
    } else if (c === "\"" && field === "") {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

function csvToMarkdown(data: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    text = new TextDecoder("shift_jis").decode(data); // Japanese spreadsheets often save as Shift_JIS
  }
  return sheetMarkdown("Sheet1", parseCsv(text));
}

/* ---------------- PPTX ---------------- */

const aText = (n: XNode): string => {
  let s = "";
  for (const k of n.kids) {
    if (typeof k !== "string") {
      if (k.name === "a:t") s += k.kids.filter((x) => typeof x === "string").join("");
      else if (k.name === "a:br") s += " ";
      else s += aText(k);
    }
  }
  return s;
};

const isTitleShape = (sp: XNode): boolean => {
  const ph = child(child(child(sp, "p:nvSpPr"), "p:nvPr"), "p:ph");
  const type = attrOf(ph, "type");
  return type === "title" || type === "ctrTitle";
};

async function pptxToMarkdown(data: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(data);
  const slideNo = (n: string) => Number(/slide(\d+)\.xml$/.exec(n)?.[1] ?? 0);
  const names = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNo(a) - slideNo(b));
  if (names.length === 0) throw new Error("no slides");

  const sections: string[] = [];
  for (const name of names) {
    const root = parseXml((await zip.file(name)!.async("string")).replace(/^﻿/, ""));
    const titleParts: string[] = [];
    const bullets: { lvl: number; text: string }[] = [];
    const walk = (node: XNode, inTitle: boolean) => {
      for (const k of elems(node)) {
        if (k.name === "p:sp") walk(k, inTitle || isTitleShape(k));
        else if (k.name === "a:p") {
          const text = aText(k).replace(/\s+/g, " ").trim();
          if (!text) continue;
          if (inTitle) titleParts.push(text);
          else bullets.push({ lvl: Number(attrOf(child(k, "a:pPr"), "lvl") ?? 0) || 0, text });
        } else walk(k, inTitle);
      }
    };
    walk(root, false);
    let title = titleParts.join(" ").trim();
    if (!title && bullets.length) title = bullets.shift()!.text;
    const n = sections.length + 1;
    const lines = [`## ${title || `Slide ${n}`}`, ...bullets.map((b) => `${"  ".repeat(b.lvl)}- ${b.text}`)];
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
}

/* ---------------- EML ---------------- */

/** Header values are decoded as UTF-8 (raw UTF-8 headers are common); the body keeps its bytes as a latin1 string until its charset is known. */
type Hdrs = Map<string, string>;

function parseHeaders(head: string): Hdrs {
  const lines: string[] = [];
  for (const line of decodeText(Buffer.from(head, "latin1")).split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && lines.length) lines[lines.length - 1] += " " + line.trim();
    else if (line) lines.push(line);
  }
  const h: Hdrs = new Map();
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    if (!h.has(name)) h.set(name, line.slice(idx + 1).trim());
  }
  return h;
}

function splitEntity(raw: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(raw);
  return m ? { head: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) } : { head: raw, body: "" };
}

function parseParams(value: string): { type: string; params: Record<string, string> } {
  const [type, ...rest] = value.split(";");
  const params: Record<string, string> = {};
  for (const p of rest.join(";").matchAll(/([^\s=;]+)\s*=\s*(?:"([^"]*)"|([^;\s]*))/g)) params[p[1].toLowerCase()] = p[2] ?? p[3] ?? "";
  return { type: type.trim().toLowerCase(), params };
}

function decodeBytes(bytes: Buffer, charset: string): string {
  const label = charset.split("*")[0].trim().toLowerCase() || "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return decodeText(bytes);
  }
}

function qpToBytes(raw: string, underscoreIsSpace: boolean): Buffer {
  let s = raw.replace(/[ \t]+(\r?\n)/g, "$1").replace(/=\r?\n/g, "");
  if (underscoreIsSpace) s = s.replace(/_/g, " ");
  return Buffer.from(s.replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
}

/** RFC 2047 encoded words (=?charset?B|Q?text?=); adjacent words lose the whitespace between them. */
export function decodeWords(s: string): string {
  const ENC = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;
  return s
    .replace(/(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)\s+(?==\?)/g, "$1")
    .replace(ENC, (_m, cs: string, enc: string, txt: string) => {
      const bytes = enc.toUpperCase() === "B" ? Buffer.from(txt, "base64") : qpToBytes(txt, true);
      return decodeBytes(bytes, cs);
    })
    .replace(/\s+/g, " ")
    .trim();
}

function decodeTransfer(raw: string, cte: string, charset: string): string {
  const enc = cte.trim().toLowerCase();
  let bytes: Buffer;
  if (enc === "base64") bytes = Buffer.from(raw, "base64");
  else if (enc === "quoted-printable") bytes = qpToBytes(raw, false);
  else bytes = Buffer.from(raw, "latin1");
  return decodeBytes(bytes, charset).replace(/\r\n?/g, "\n");
}

/** Parts of a multipart body (the delimiter lines are removed; each part is raw text). */
function splitMultipart(raw: string, boundary: string): string[] {
  const delim = `\n--${boundary}`;
  const text = `\n${raw}`;
  const idx: number[] = [];
  for (let p = text.indexOf(delim); p >= 0; p = text.indexOf(delim, p + delim.length)) idx.push(p);
  const parts: string[] = [];
  for (let k = 0; k < idx.length; k++) {
    const after = idx[k] + delim.length;
    if (text.startsWith("--", after)) break;
    const lineEnd = text.indexOf("\n", after);
    if (lineEnd < 0) break;
    const end = k + 1 < idx.length ? idx[k + 1] : text.length;
    let seg = text.slice(lineEnd + 1, end);
    if (seg.endsWith("\r")) seg = seg.slice(0, -1);
    parts.push(seg);
  }
  return parts;
}

interface Bodies { plain?: string; html?: string }

function collectBodies(raw: string, headers: Hdrs, depth: number, out: Bodies): void {
  if (depth > 10) return;
  if ((headers.get("content-disposition") ?? "").toLowerCase().startsWith("attachment")) return;
  const ct = parseParams(headers.get("content-type") ?? "text/plain");
  if (ct.type.startsWith("multipart/")) {
    if (!ct.params.boundary) return;
    for (const part of splitMultipart(raw, ct.params.boundary)) {
      const e = splitEntity(part);
      collectBodies(e.body, parseHeaders(e.head), depth + 1, out);
    }
    return;
  }
  if (ct.type !== "text/plain" && ct.type !== "text/html") return;
  const key = ct.type === "text/plain" ? "plain" : "html";
  if (out[key] !== undefined) return;
  out[key] = decodeTransfer(raw, headers.get("content-transfer-encoding") ?? "7bit", ct.params.charset ?? "utf-8");
}

/** HTML to plain text: scripts and styles dropped, block ends become line breaks, entities decoded. */
function stripHtml(html: string): string {
  const text = html
    .replace(/<(style|script)[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return unescapeEntities(text)
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** .eml -> artifact content: To/Cc/Bcc/Subject lines, a blank line, then the body. */
function emlToContent(data: Buffer): string {
  const raw = data.toString("latin1");
  const top = splitEntity(raw);
  const headers = parseHeaders(top.head);
  const bodies: Bodies = {};
  collectBodies(top.body, headers, 0, bodies);
  const body = bodies.plain !== undefined ? bodies.plain : bodies.html !== undefined ? stripHtml(bodies.html) : "";

  const lines: string[] = [];
  for (const [label, name] of [["To", "to"], ["Cc", "cc"], ["Bcc", "bcc"], ["Subject", "subject"]] as const) {
    const v = decodeWords(headers.get(name) ?? "");
    if (v) lines.push(`${label}: ${v}`);
  }
  const text = body.replace(/\s+$/, "").replace(/^\n+/, "");
  return lines.length ? `${lines.join("\n")}\n\n${text}` : text;
}

/* ---------------- route ---------------- */

export function registerImportRoutes(app: FastifyInstance): void {
  app.post("/artifacts/import", { bodyLimit: IMPORT_BODY_LIMIT }, async (req) => {
    authFromRequest(req);
    const b = (req.body ?? {}) as any;
    if (typeof b.filename !== "string" || !b.filename.trim()) throw bad("filename must be a non-empty string");
    if (typeof b.data !== "string") throw bad("data must be a base64 string");
    const b64 = b.data.replace(/\s+/g, "");
    if (!b64 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw bad("data must be base64");
    const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    if ((b64.length / 4) * 3 - pad > MAX_BYTES) throw bad("The file is larger than 5 MB", 413);
    return importDocument(b.filename, Buffer.from(b64, "base64"));
  });
}
