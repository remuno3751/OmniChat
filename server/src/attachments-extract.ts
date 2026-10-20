/* Text extraction for document attachments (docs/design/ATTACHMENTS.md "文書からのテキスト抽出").
   Runs once at upload; the result is stored (attachments.ts writes <id>.txt). Never logs the text.
   Failures do not throw: they come back as a warning and the attachment is kept. */
import JSZip from "jszip";
import ExcelJS from "exceljs";
import type { DetectedType } from "./attachments-types.js";
import { decodeText } from "./attachments-types.js";

export const EXTRACT_TIMEOUT_MS = 20_000;
/** Expanded size of an Office container we are willing to read (zip-bomb guard). */
export const EXPANDED_LIMIT = 100 * 1024 * 1024;
export const PDF_MAX_PAGES = 200;
export const XLSX_MAX_ROWS = 2000;
export const XLSX_MAX_COLS = 50;
/** Largest text kept on disk per attachment (the model-facing cut is extractMaxChars, see attachments.ts). */
export const STORE_MAX_CHARS = 2_000_000;

export interface ExtractOutcome {
  /** null: this type has no text to extract (images, audio) */
  text: string | null;
  warning?: string;
}

const decodeXml = (s: string): string =>
  s.replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => safeChar(parseInt(d, 10)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function safeChar(n: number): string {
  try { return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ""; } catch { return ""; }
}

/** Text of an OOXML part: the text runs (`<w:t>` / `<a:t>`), one line per paragraph. */
export function ooxmlText(xml: string, textTag: string, paraTag: string): string {
  const re = new RegExp(`<${textTag}(?:\\s[^>]*)?>([^<]*)</${textTag}>|</${paraTag}>|<[^>]+>`, "g");
  return xml
    .replace(re, (m, t: string | undefined) => (t !== undefined ? decodeXml(t) : m === `</${paraTag}>` ? "\n" : ""))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Sum of the uncompressed sizes of a zip's entries (from the central directory; nothing is inflated). */
function expandedSize(zip: JSZip): number {
  let total = 0;
  for (const f of Object.values(zip.files)) total += Number((f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0);
  return total;
}

async function openZip(buf: Buffer): Promise<JSZip> {
  const zip = await JSZip.loadAsync(buf);
  if (expandedSize(zip) > EXPANDED_LIMIT) throw new Error("expanded size over the limit");
  return zip;
}

async function docxText(buf: Buffer): Promise<string> {
  const zip = await openZip(buf);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (xml === undefined) throw new Error("no document part");
  return ooxmlText(xml, "w:t", "w:p");
}

async function pptxText(buf: Buffer): Promise<string> {
  const zip = await openZip(buf);
  const slideNames = Object.keys(zip.files)
    .map((n) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(n))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  const parts: string[] = [];
  for (const m of slideNames) {
    const n = Number(m[1]);
    const xml = await zip.file(m[0])!.async("string");
    parts.push(`--- スライド ${n} ---\n${ooxmlText(xml, "a:t", "a:p")}`);
    // the notes of this slide, through its relationships part
    const rels = await zip.file(`ppt/slides/_rels/slide${n}.xml.rels`)?.async("string");
    const note = rels ? /notesSlides\/(notesSlide\d+\.xml)/.exec(rels)?.[1] : undefined;
    const noteXml = note ? await zip.file(`ppt/notesSlides/${note}`)?.async("string") : undefined;
    if (noteXml) {
      const t = ooxmlText(noteXml, "a:t", "a:p");
      if (t) parts.push(`(ノート)\n${t}`);
    }
  }
  if (parts.length === 0) throw new Error("no slides");
  return parts.join("\n\n");
}

async function xlsxText(buf: Buffer): Promise<string> {
  await openZip(buf); // size guard before ExcelJS inflates everything
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const parts: string[] = [];
  wb.eachSheet((ws) => {
    const lines: string[] = [];
    const rows = Math.min(ws.rowCount, XLSX_MAX_ROWS);
    const cols = Math.min(ws.columnCount, XLSX_MAX_COLS);
    for (let r = 1; r <= rows; r++) {
      const row = ws.getRow(r);
      const cells: string[] = [];
      for (let c = 1; c <= cols; c++) cells.push(String(row.getCell(c).text ?? "").replace(/[\t\r\n]+/g, " "));
      lines.push(cells.join("\t").replace(/\t+$/, ""));
    }
    if (ws.rowCount > rows || ws.columnCount > cols) lines.push(`(以下省略: ${ws.rowCount} 行 × ${ws.columnCount} 列中、${rows} 行 × ${cols} 列まで)`);
    parts.push(`--- シート: ${ws.name} ---\n${lines.join("\n")}`);
  });
  return parts.join("\n\n");
}

interface PdfOutcome { text: string; warning?: string }

async function pdfText(buf: Buffer): Promise<PdfOutcome> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });
  let doc: Awaited<typeof task.promise> | undefined;
  try {
    doc = await task.promise;
    const n = Math.min(doc.numPages, PDF_MAX_PAGES);
    const parts: string[] = [];
    let chars = 0;
    for (let p = 1; p <= n; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      let s = "";
      for (const it of tc.items as { str?: string; hasEOL?: boolean }[]) {
        if (typeof it.str === "string") s += it.str;
        if (it.hasEOL) s += "\n";
      }
      s = s.replace(/[ \t]+\n/g, "\n").trim();
      chars += s.length;
      parts.push(`--- ページ ${p} ---\n${s}`);
      page.cleanup();
    }
    const warn = doc.numPages > n ? `ページ数が多いため、先頭 ${n} ページのみ抽出しました(全 ${doc.numPages} ページ)` : undefined;
    if (chars === 0) return { text: "", warning: "文字が取れませんでした(スキャン PDF の可能性があります。OCR には対応していません)" };
    return { text: parts.join("\n\n"), warning: warn };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

function textOf(buf: Buffer, mime: string): ExtractOutcome {
  const decoded = decodeText(buf);
  if (decoded === null) return { text: null, warning: "文字コードを判定できませんでした(UTF-8 か Shift_JIS のテキストではありません)" };
  if (mime === "text/html") {
    const t = decoded
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n+/g, "\n\n")
      .trim();
    return { text: decodeXml(t) };
  }
  return { text: decoded };
}

/** Extracts the text of a document attachment (one run, bounded by EXTRACT_TIMEOUT_MS). Never throws. */
export async function extractAttachmentText(type: DetectedType, buf: Buffer): Promise<ExtractOutcome> {
  if (type.kind !== "document") return { text: null };
  const work = async (): Promise<ExtractOutcome> => {
    if (type.text) return textOf(buf, type.mime);
    if (type.mime === "application/pdf") return pdfText(buf);
    if (type.mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return { text: await docxText(buf) };
    if (type.mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return { text: await pptxText(buf) };
    if (type.mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return { text: await xlsxText(buf) };
    return { text: null };
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<ExtractOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ text: "", warning: "抽出に時間がかかりすぎたため中止しました" }), EXTRACT_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch {
    // The message of a library error may contain document text: report only the fact.
    return { text: "", warning: "テキストを取り出せませんでした(形式が壊れているか、未対応の形式です)" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
