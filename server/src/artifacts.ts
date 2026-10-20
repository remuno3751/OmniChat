import type { FastifyInstance } from "fastify";
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType } from "docx";
import PptxGenJS from "pptxgenjs";
import { authFromRequest, AuthError } from "./auth.js";
import { inlineRuns, parseMarkdown, toSlides, type Block, type Run, type ShapeBox, type ShapeBoxType, type ShapeChart, type ShapeDash, type ShapesSpec, type Slide } from "./docmodel.js";
import { attachShapes, arrowSegment, type Segment } from "./shapes.js";
import { parseSheets, cellValue } from "./sheetmodel.js";
import { registerImportRoutes } from "./artifacts-import.js";
import ExcelJS from "exceljs";

export { inlineRuns, parseMarkdown, toSlides };
export type { Block, Run };

/** Markdown -> slides with each ```shapes block parsed (blocks that do not parse fall back to code). */
export function markdownToSlides(md: string, title: string): Slide[] {
  return toSlides(attachShapes(parseMarkdown(md)), title);
}

/* Phase 5 (PROTOCOL-v3-phase5.md section 4): documents for the artifact panel. Markdown in, .docx / .pptx / .xlsx out. */

export const CONVERT_LIMIT = 1_000_000;
export type ConvertType = "docx" | "pptx" | "xlsx";
const MIME: Record<ConvertType, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};


/* ---------------- .docx ---------------- */

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];

const docxRuns = (text: string, bold = false): TextRun[] =>
  inlineRuns(text).map((r) => new TextRun({ text: r.text, bold: r.bold || bold, italics: r.italics, font: r.code ? "Consolas" : undefined }));

/** Text of a shapes spec for the docx stand-in: element texts, arrow labels and chart titles, in order. */
const shapeTexts = (spec: ShapesSpec): string[] => {
  const out: string[] = [];
  for (const e of spec.elements) {
    const t = e.type === "line" ? undefined : e.type === "arrow" ? e.label : e.type === "chart" ? (e.title ? `グラフ: ${e.title}` : undefined) : e.text;
    if (t) out.push(t);
  }
  return out;
};

export async function markdownToDocx(md: string, title: string): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];
  for (const b of attachShapes(parseMarkdown(md))) {
    if (b.kind === "heading") children.push(new Paragraph({ heading: HEADINGS[Math.min(b.level, 6) - 1], children: docxRuns(b.text) }));
    else if (b.kind === "shapes" && !b.spec) {
      for (const line of b.raw.split("\n")) children.push(new Paragraph({ children: [new TextRun({ text: line || " ", font: "Consolas", size: 20 })] }));
      children.push(new Paragraph({ children: [] }));
    } else if (b.kind === "shapes") {
      children.push(new Paragraph({ children: [new TextRun({ text: "(図)", bold: true })] }));
      for (const t of shapeTexts(b.spec!)) children.push(new Paragraph({ bullet: { level: 0 }, children: docxRuns(t) }));
    }
    else if (b.kind === "para") children.push(new Paragraph({ children: docxRuns(b.text), spacing: { after: 120 } }));
    else if (b.kind === "bullet") children.push(new Paragraph({ bullet: { level: b.level }, children: docxRuns(b.text) }));
    else if (b.kind === "ordered") children.push(new Paragraph({ indent: { left: 360 }, children: [new TextRun(`${b.n}. `), ...docxRuns(b.text)] }));
    else if (b.kind === "code") {
      for (const line of b.lines) children.push(new Paragraph({ children: [new TextRun({ text: line || " ", font: "Consolas", size: 20 })] }));
      children.push(new Paragraph({ children: [] }));
    } else {
      const cols = b.rows[0].length;
      const rows = b.rows.map((r, ri) => {
        const cells = Array.from({ length: cols }, (_, ci) => r[ci] ?? "");
        return new TableRow({
          tableHeader: ri === 0,
          children: cells.map((c) => new TableCell({ children: [new Paragraph({ children: docxRuns(c, ri === 0) })] })),
        });
      });
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }));
      children.push(new Paragraph({ children: [] }));
    }
  }
  if (!children.length) children.push(new Paragraph({ children: [] }));
  const doc = new Document({ creator: "OmniChat", title, sections: [{ children }] });
  return Packer.toBuffer(doc);
}

/* ---------------- .pptx ---------------- */


type TextPart = { text: string; options: Record<string, unknown> };
const pptxParts = (text: string, base: Record<string, unknown>): TextPart[] => {
  const runs = inlineRuns(text);
  return runs.map((r, i) => ({
    text: r.text,
    options: {
      ...base,
      ...(r.bold ? { bold: true } : {}),
      ...(r.italics ? { italic: true } : {}),
      ...(r.code ? { fontFace: "Consolas" } : {}),
      ...(i === runs.length - 1 ? { breakLine: true } : {}),
    },
  }));
};

/** The package's typings declare a namespace, but the runtime export is the class. */
const PptxCtor = PptxGenJS as unknown as new () => any;

/* Slide shapes (docs/design/SLIDE-SHAPES.md). The slide is 13.333 x 7.5 in; spec coordinates are percentages of it. */
const SLIDE_W = 13.333, SLIDE_H = 7.5;
const inX = (v: number) => (v / 100) * SLIDE_W;
const inY = (v: number) => (v / 100) * SLIDE_H;
/** pptxgenjs takes colors without the leading "#". */
const rgb = (c: string) => c.replace(/^#/, "");
const LINE_DEFAULT = "#374151";
const SHAPE_FILL_DEFAULT = "#e5e7eb";
const BOX_PPTX: Record<ShapeBoxType, string> = {
  rect: "rect", roundRect: "roundRect", ellipse: "ellipse", diamond: "diamond", triangle: "triangle",
  parallelogram: "parallelogram", hexagon: "hexagon", pentagon: "pentagon", chevron: "chevron",
  rightArrow: "rightArrow", leftArrow: "leftArrow", upArrow: "upArrow", downArrow: "downArrow",
  cylinder: "can", star: "star5", cloud: "cloud", callout: "wedgeRoundRectCallout", text: "rect",
};
const DASH_PPTX: Record<ShapeDash, string> = { solid: "solid", dash: "dash", dot: "sysDot" };
/** Where the body text goes when a slide has shapes: [x, y, width, max height] in inches; null = no body. */
const BODY_DEFAULT = { x: 0.6, y: 1.5, w: 12.1, maxH: 4.2 };
const BODY_REGION: Record<ShapesSpec["body"], { x: number; y: number; w: number; maxH: number } | null> = {
  top: { x: 0.6, y: 1.5, w: 12.1, maxH: 2.25 },
  left: { x: 0.6, y: 1.5, w: 6.0, maxH: 5.5 },
  right: { x: SLIDE_W - 0.6 - 6.0, y: 1.5, w: 6.0, maxH: 5.5 },
  none: null,
};

const fillOf = (color: string | undefined, opacity: number | undefined) =>
  color === undefined || color === "none" ? { type: "none" } : { color: rgb(color), transparency: Math.round((1 - (opacity ?? 1)) * 100) };

function drawBox(s: any, e: ShapeBox): void {
  const pos = { x: inX(e.x), y: inY(e.y), w: inX(e.w), h: inY(e.h), rotate: e.rotate };
  if (e.type !== "text") {
    s.addShape(BOX_PPTX[e.type] ?? "rect", {
      ...pos,
      fill: fillOf(e.fill ?? SHAPE_FILL_DEFAULT, e.opacity),
      line: e.line && e.line !== "none" ? { color: rgb(e.line), width: e.lineWidth ?? 1.5 } : { type: "none" },
    });
  }
  if (e.text) {
    s.addText(e.text, {
      ...pos, fontSize: e.size ?? 18, color: rgb(e.color ?? "#222222"), bold: e.bold, italic: e.italic,
      align: e.align ?? "center", valign: e.valign ?? "middle",
      fill: e.type === "text" ? fillOf(e.fill, e.opacity) : { type: "none" },
    });
  }
}

function drawLine(s: any, seg: Segment, o: { color?: string; width?: number; dash?: ShapeDash; head: "none" | "end" | "both" }): void {
  s.addShape("line", {
    x: inX(Math.min(seg.x1, seg.x2)), y: inY(Math.min(seg.y1, seg.y2)),
    w: inX(Math.abs(seg.x2 - seg.x1)), h: inY(Math.abs(seg.y2 - seg.y1)),
    flipH: seg.x1 > seg.x2, flipV: seg.y1 > seg.y2,
    line: {
      color: rgb(o.color ?? LINE_DEFAULT), width: o.width ?? 1.5, dashType: DASH_PPTX[o.dash ?? "solid"],
      beginArrowType: o.head === "both" ? "triangle" : undefined,
      endArrowType: o.head === "none" ? undefined : "triangle",
    },
  });
}

function drawChart(s: any, c: ShapeChart): void {
  const pie = c.kind === "pie" || c.kind === "doughnut";
  s.addChart(c.kind === "column" || c.kind === "bar" ? "bar" : c.kind,
    c.series.map((se) => ({ name: se.name || " ", labels: c.categories, values: se.values })), {
      x: inX(c.x), y: inY(c.y), w: inX(c.w), h: inY(c.h),
      barDir: c.kind === "bar" ? "bar" : "col",
      showTitle: !!c.title, title: c.title ?? "", titleFontSize: 14,
      showLegend: c.series.length >= 2 || pie, legendPos: "b", legendFontSize: 12,
      catAxisLabelFontSize: 12, valAxisLabelFontSize: 12,
    });
}

function drawShapes(s: any, spec: ShapesSpec): void {
  const boxes = new Map<string, ShapeBox>();
  for (const e of spec.elements) if (e.type !== "line" && e.type !== "arrow" && e.type !== "chart" && e.id !== undefined) boxes.set(e.id, e);
  for (const e of spec.elements) {
    if (e.type === "line") drawLine(s, { x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2 }, { color: e.color, width: e.width, dash: e.dash, head: e.head ?? "none" });
    else if (e.type === "arrow") {
      const seg = arrowSegment(e, boxes);
      if (!seg) continue;
      drawLine(s, seg, { color: e.color, width: e.width, dash: e.dash, head: "end" });
      if (e.label) {
        const mx = inX((seg.x1 + seg.x2) / 2), my = inY((seg.y1 + seg.y2) / 2);
        s.addText(e.label, { x: mx - 1, y: my - 0.25, w: 2, h: 0.5, fontSize: 12, color: "374151", align: "center", valign: "middle", fill: { color: "FFFFFF" } });
      }
    } else if (e.type === "chart") drawChart(s, e);
    else drawBox(s, e);
  }
}

export async function markdownToPptx(md: string, title: string): Promise<Buffer> {
  const pres = new PptxCtor();
  pres.layout = "LAYOUT_WIDE";
  pres.title = title;
  pres.author = "OmniChat";
  for (const sl of markdownToSlides(md, title)) {
    const s = pres.addSlide();
    s.addText(inlineRuns(sl.title).map((r) => r.text).join("") || " ", {
      x: 0.6, y: 0.35, w: 12.1, h: 1.0, fontSize: 30, bold: true, color: "1F2937", fit: "shrink",
    });
    // All ```shapes blocks of the slide are merged into one spec.
    const specs = sl.blocks.flatMap((b: Block) => (b.kind === "shapes" && b.spec ? [b.spec] : []));
    const merged: ShapesSpec | undefined = specs.length ? {
      bg: specs.map((x) => x.bg).find((x) => x !== undefined),
      body: specs[0].body,
      notes: specs.map((x) => x.notes).filter((x) => x).join("\n") || undefined,
      elements: specs.flatMap((x) => x.elements),
    } : undefined;
    const region = merged ? BODY_REGION[merged.body] : BODY_DEFAULT;
    const parts: TextPart[] = [];
    const tables: string[][][] = [];
    for (const b of sl.blocks) {
      if (b.kind === "table") tables.push(b.rows);
      else if (b.kind === "code") for (const line of b.lines) parts.push(...pptxParts(line || " ", { fontFace: "Consolas", fontSize: 16 }));
      else if (b.kind === "bullet") parts.push(...pptxParts(b.text, { bullet: true, indentLevel: b.level }));
      else if (b.kind === "ordered") parts.push(...pptxParts(b.text, { bullet: { type: "number" } }));
      else if (b.kind === "para") parts.push(...pptxParts(b.text, { bullet: false }));
      else if (b.kind === "shapes") continue;
      else parts.push(...pptxParts(b.text, { bullet: false }));
    }
    if (region) {
      let y = region.y;
      if (parts.length) {
        const h = Math.min(region.maxH, Math.max(0.8, parts.length * 0.5));
        s.addText(parts as any, { x: region.x, y, w: region.w, h, fontSize: 20, color: "222222", valign: "top", fit: "shrink" });
        y += h + 0.2;
      }
      for (const rows of tables) {
        const cols = rows[0].length;
        const data = rows.map((r, ri) => Array.from({ length: cols }, (_, ci) => ({
          text: r[ci] ?? "",
          options: { bold: ri === 0, fontSize: 14, ...(ri === 0 ? { fill: { color: "E5E7EB" } } : {}) },
        })));
        s.addTable(data as any, {
          x: region.x, y, w: region.w, colW: Array(cols).fill(region.w / cols), border: { type: "solid", pt: 0.75, color: "9CA3AF" },
        });
        y += rows.length * 0.42 + 0.3;
      }
    }
    if (merged) {
      if (merged.bg) s.background = { color: rgb(merged.bg) };
      drawShapes(s, merged);
      if (merged.notes) s.addNotes(merged.notes);
    }
  }
  return (await pres.write({ outputType: "nodebuffer" })) as Buffer;
}

/* ---------------- .xlsx ---------------- */

const CJK = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
/** Display width of a cell in characters (CJK and full-width characters count 2). */
const textWidth = (s: string): number => {
  let n = 0;
  for (const ch of s) n += CJK.test(ch) ? 2 : 1;
  return n;
};

export async function markdownToXlsx(md: string, title: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "OmniChat";
  wb.title = title;
  const sheets = parseSheets(md);
  if (!sheets.length) sheets.push({ name: "Sheet1", rows: [], header: false });
  for (const sh of sheets) {
    const ws = wb.addWorksheet(sh.name);
    const width = Math.max(0, ...sh.rows.map((r) => r.length));
    const cols: number[] = Array.from({ length: width }, () => 0);
    sh.rows.forEach((row, ri) => {
      row.forEach((cell, ci) => {
        const c = ws.getCell(ri + 1, ci + 1);
        const cv = cellValue(cell);
        if (cv.t === "formula") c.value = { formula: cv.f };
        else if (cv.t === "number") c.value = cv.v;
        else if (cell !== "") c.value = cell;
        if (sh.header && ri === 0) c.font = { bold: true };
        const len = cv.t === "number" ? String(cv.v).length : textWidth(cell);
        cols[ci] = Math.max(cols[ci], len);
      });
    });
    cols.forEach((len, ci) => { ws.getColumn(ci + 1).width = Math.min(60, Math.max(8, len + 2)); });
    if (sh.header) ws.views = [{ state: "frozen", ySplit: 1, topLeftCell: "A2", activeCell: "A2" }];
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* ---------------- route ---------------- */

const bad = (m: string, status = 400) => new AuthError(m, status);
/** Title -> safe file name stem (no path or control characters, <= 100 chars). */
export function fileStem(title: unknown, fallback: string): string {
  const t = typeof title === "string" ? title.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) : "";
  return t || fallback;
}
/** RFC 5987 value for Content-Disposition (encodeURIComponent plus the characters it leaves alone). */
const rfc5987 = (s: string) => encodeURIComponent(s).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/** Validates a convert / convert-preview body (same rules for both). */
function convertInput(body: any): { type: ConvertType; markdown: string; stem: string } {
  const b = body ?? {};
  if (b.type !== "docx" && b.type !== "pptx" && b.type !== "xlsx") throw bad("type must be docx, pptx or xlsx");
  if (typeof b.markdown !== "string") throw bad("markdown must be a string");
  if (b.markdown.length > CONVERT_LIMIT) throw bad("markdown is larger than 1 MB", 413);
  if (b.title !== undefined && b.title !== null && typeof b.title !== "string") throw bad("title must be a string");
  const type = b.type as ConvertType;
  const fallback = type === "docx" ? "document" : type === "pptx" ? "presentation" : "spreadsheet";
  return { type, markdown: b.markdown, stem: fileStem(b.title, fallback) };
}

export function registerArtifactRoutes(app: FastifyInstance): void {
  app.post("/artifacts/convert", async (req, reply) => {
    authFromRequest(req);
    const { type, markdown, stem } = convertInput(req.body);
    const out = type === "docx" ? await markdownToDocx(markdown, stem)
      : type === "pptx" ? await markdownToPptx(markdown, stem)
      : await markdownToXlsx(markdown, stem);
    reply.header("Content-Type", MIME[type]);
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${rfc5987(`${stem}.${type}`)}`);
    reply.header("Content-Length", String(out.length));
    return reply.send(out);
  });
  /* Same input as /artifacts/convert; answers the slides as JSON, with each ```shapes block carrying its validated `spec`. */
  app.post("/artifacts/convert/preview", async (req) => {
    authFromRequest(req);
    const { markdown, stem } = convertInput(req.body);
    return { slides: markdownToSlides(markdown, stem).map((s) => ({ title: s.title, blocks: s.blocks })) };
  });
  registerImportRoutes(app);
}
