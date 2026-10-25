import JSZip from "jszip";
import { parse as parseYaml } from "yaml";

/* Native charts for .xlsx and .docx (the .pptx writer has its own, via pptxgenjs). A chart is written by the AI as a
 * ```chart block holding JSON, the same block the chat shows: {"type": "column", "title": "...", "labels": [...],
 * "series": [{"name": "...", "data": [...]}]}. In a sheet, `labels` and `series` may be left out: the chart then
 * reads the sheet's table (first column = categories, the numeric columns = series). */

export type ChartKind = "column" | "bar" | "line" | "pie" | "doughnut" | "area";
export interface ChartSeries { name: string; values: number[] }
export interface ChartDef { kind: ChartKind; title?: string; categories?: string[]; series?: ChartSeries[] }
/** Cell references of a sheet-bound chart (sheet name already quoted, e.g. 'Sales'). */
export interface ChartRefs { catRef: string; series: { nameRef: string; valRef: string }[] }

const KINDS: Record<string, ChartKind> = {
  column: "column", bar: "bar", line: "line", pie: "pie", doughnut: "doughnut", donut: "doughnut", area: "area",
  "縦棒": "column", "横棒": "bar", "折れ線": "line", "円": "pie",
};
const PALETTE = ["2563EB", "F59E0B", "10B981", "EF4444", "8B5CF6", "06B6D4", "EC4899", "64748B"];
const MAX_SERIES = 8, MAX_POINTS = 100;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** JSON of a ```chart block -> a definition, or null when it is not one. "bar" in the chat means vertical bars. */
export function parseChartJson(raw: string): ChartDef | null {
  let j: any;
  try { j = JSON.parse(raw); } catch {
    // models sometimes write the block as YAML
    try { j = parseYaml(raw); } catch { return null; }
  }
  if (!j || typeof j !== "object") return null;
  const t = String(j.type ?? j.kind ?? "column").toLowerCase();
  const kind = KINDS[t] ?? KINDS[String(j.type ?? "")];
  if (!kind) return null;
  const def: ChartDef = { kind: t === "bar" && j.horizontal !== true && j.barDir !== "bar" ? "column" : kind };
  if (typeof j.title === "string" && j.title.trim()) def.title = j.title.trim().slice(0, 120);
  const labels = j.labels ?? j.categories;
  if (Array.isArray(labels) && Array.isArray(j.series)) {
    def.categories = labels.slice(0, MAX_POINTS).map((l: unknown) => String(l));
    def.series = j.series.slice(0, MAX_SERIES).map((s: any, i: number) => ({
      name: String(s?.name ?? `Series ${i + 1}`).slice(0, 60),
      values: (Array.isArray(s?.data ?? s?.values) ? (s.data ?? s.values) : []).slice(0, MAX_POINTS).map((v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0)),
    }));
    if (!def.series!.length || !def.categories.length) return null;
  }
  return def;
}

/** ```chart fences of a markdown text: where they are (line range) and what they hold. */
export function findChartBlocks(md: string): { start: number; end: number; raw: string }[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: { start: number; end: number; raw: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(`{3,}|~{3,})\s*chart\s*$/i.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !new RegExp(`^\\s*${m[1][0] === "`" ? "`" : "~"}{${m[1].length},}\\s*$`).test(lines[j])) j++;
    out.push({ start: i, end: Math.min(j, lines.length - 1), raw: lines.slice(i + 1, j).join("\n") });
    i = j;
  }
  return out;
}

const txPr = (sz: number): string => `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${sz}"/></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>`;
const fill = (c: string): string => `<c:spPr><a:solidFill><a:srgbClr val="${c}"/></a:solidFill></c:spPr>`;
const lineFill = (c: string): string => `<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${c}"/></a:solidFill><a:round/></a:ln></c:spPr>`;

function strData(ref: string | undefined, vals: string[]): string {
  const cache = `<c:ptCount val="${vals.length}"/>${vals.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join("")}`;
  return ref ? `<c:strRef><c:f>${esc(ref)}</c:f><c:strCache>${cache}</c:strCache></c:strRef>` : `<c:strLit>${cache}</c:strLit>`;
}
function numData(ref: string | undefined, vals: number[]): string {
  const cache = `<c:formatCode>General</c:formatCode><c:ptCount val="${vals.length}"/>${vals.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join("")}`;
  return ref ? `<c:numRef><c:f>${esc(ref)}</c:f><c:numCache>${cache}</c:numCache></c:numRef>` : `<c:numLit>${cache}</c:numLit>`;
}

/** The chart part (word/charts/chartN.xml or xl/charts/chartN.xml). `def` must have categories and series. */
export function chartXml(def: ChartDef, refs?: ChartRefs): string {
  const cats = def.categories ?? [], series = def.series ?? [];
  const pieLike = def.kind === "pie" || def.kind === "doughnut";
  const sers = series.map((s, i) => {
    const color = PALETTE[i % PALETTE.length];
    const look = pieLike
      ? cats.map((_, k) => `<c:dPt><c:idx val="${k}"/><c:bubble3D val="0"/>${fill(PALETTE[k % PALETTE.length])}</c:dPt>`).join("")
      : def.kind === "line" ? lineFill(color) + '<c:marker><c:symbol val="circle"/><c:size val="6"/></c:marker>' : fill(color);
    const r = refs?.series[i];
    return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx>${r?.nameRef ? strData(r.nameRef, [s.name]) : `<c:v>${esc(s.name)}</c:v>`}</c:tx>${look}<c:cat>${strData(refs?.catRef, cats)}</c:cat><c:val>${numData(r?.valRef, s.values)}</c:val>${def.kind === "line" ? '<c:smooth val="0"/>' : ""}</c:ser>`;
  }).join("");
  const axIds = '<c:axId val="111111111"/><c:axId val="222222222"/>';
  let plot: string;
  if (def.kind === "pie") plot = `<c:pieChart><c:varyColors val="1"/>${sers}<c:firstSliceAng val="0"/></c:pieChart>`;
  else if (def.kind === "doughnut") plot = `<c:doughnutChart><c:varyColors val="1"/>${sers}<c:firstSliceAng val="0"/><c:holeSize val="55"/></c:doughnutChart>`;
  else if (def.kind === "line") plot = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${sers}<c:marker val="1"/>${axIds}</c:lineChart>`;
  else if (def.kind === "area") plot = `<c:areaChart><c:grouping val="standard"/><c:varyColors val="0"/>${sers}${axIds}</c:areaChart>`;
  else plot = `<c:barChart><c:barDir val="${def.kind === "bar" ? "bar" : "col"}"/><c:grouping val="clustered"/><c:varyColors val="0"/>${sers}<c:gapWidth val="80"/>${axIds}</c:barChart>`;
  const horizontal = def.kind === "bar";
  const axes = pieLike ? "" :
    `<c:catAx><c:axId val="111111111"/><c:scaling><c:orientation val="${horizontal ? "maxMin" : "minMax"}"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? "l" : "b"}"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${txPr(1000)}<c:crossAx val="222222222"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>` +
    `<c:valAx><c:axId val="222222222"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? "b" : "l"}"/><c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="E5E7EB"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${txPr(1000)}<c:crossAx val="111111111"/><c:crosses val="${horizontal ? "max" : "autoZero"}"/><c:crossBetween val="between"/></c:valAx>`;
  const title = def.title
    ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1400" b="1"/></a:pPr><a:r><a:rPr lang="en-US" sz="1400" b="1"/><a:t>${esc(def.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`
    : '<c:autoTitleDeleted val="1"/>';
  const legend = series.length > 1 || pieLike ? `<c:legend><c:legendPos val="b"/><c:overlay val="0"/>${txPr(1000)}</c:legend>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:roundedCorners val="0"/><c:chart>${title}<c:plotArea><c:layout/>${plot}${axes}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

const CT_CHART = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";
const CT_DRAWING = "application/vnd.openxmlformats-officedocument.drawing+xml";
const REL_CHART = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart";
const REL_DRAWING = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing";

async function addContentTypes(zip: JSZip, overrides: [string, string][]): Promise<void> {
  const f = zip.file("[Content_Types].xml")!;
  let xml = await f.async("string");
  const add = overrides.filter(([p]) => !xml.includes(`PartName="${p}"`)).map(([p, t]) => `<Override PartName="${p}" ContentType="${t}"/>`).join("");
  xml = xml.replace("</Types>", add + "</Types>");
  zip.file("[Content_Types].xml", xml);
}
async function addRels(zip: JSZip, path: string, rels: { id: string; type: string; target: string }[]): Promise<void> {
  const body = rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`).join("");
  const f = zip.file(path);
  if (f) zip.file(path, (await f.async("string")).replace("</Relationships>", body + "</Relationships>"));
  else zip.file(path, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`);
}

export interface SheetChart { sheetFileId: number; def: ChartDef; refs?: ChartRefs; col: number; row: number }

/** Adds the charts to a finished .xlsx: one drawing per sheet, charts anchored at (col, row), zero based. */
export async function addXlsxCharts(xlsx: Buffer, charts: SheetChart[]): Promise<Buffer> {
  if (!charts.length) return xlsx;
  const zip = await JSZip.loadAsync(xlsx);
  const overrides: [string, string][] = [];
  const bySheet = new Map<number, SheetChart[]>();
  for (const c of charts) bySheet.set(c.sheetFileId, [...(bySheet.get(c.sheetFileId) ?? []), c]);
  let chartNo = 0, drawNo = 0;
  for (const [sheetId, list] of bySheet) {
    const sheetPath = `xl/worksheets/sheet${sheetId}.xml`;
    const sf = zip.file(sheetPath);
    if (!sf) continue;
    drawNo++;
    const anchors: string[] = [], drels: { id: string; type: string; target: string }[] = [];
    list.forEach((c, k) => {
      chartNo++;
      zip.file(`xl/charts/chart${chartNo}.xml`, chartXml(c.def, c.refs));
      overrides.push([`/xl/charts/chart${chartNo}.xml`, CT_CHART]);
      drels.push({ id: `rId${k + 1}`, type: REL_CHART, target: `../charts/chart${chartNo}.xml` });
      anchors.push(`<xdr:twoCellAnchor><xdr:from><xdr:col>${c.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${c.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${c.col + 9}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${c.row + 19}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${k + 2}" name="Chart ${k + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId${k + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`);
    });
    zip.file(`xl/drawings/drawing${drawNo}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${anchors.join("")}</xdr:wsDr>`);
    await addRels(zip, `xl/drawings/_rels/drawing${drawNo}.xml.rels`, drels);
    overrides.push([`/xl/drawings/drawing${drawNo}.xml`, CT_DRAWING]);
    await addRels(zip, `xl/worksheets/_rels/sheet${sheetId}.xml.rels`, [{ id: "rIdChartDrawing", type: REL_DRAWING, target: `../drawings/drawing${drawNo}.xml` }]);
    let sx = await sf.async("string");
    if (!/xmlns:r=/.test(sx)) sx = sx.replace("<worksheet ", '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
    sx = sx.replace("</worksheet>", '<drawing r:id="rIdChartDrawing"/></worksheet>');
    zip.file(sheetPath, sx);
  }
  await addContentTypes(zip, overrides);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** Replaces each paragraph holding the token `@@CHART:n@@` of a finished .docx with chart n (inline, 15 x 8.5 cm). */
export async function addDocxCharts(docx: Buffer, charts: ChartDef[]): Promise<Buffer> {
  if (!charts.length) return docx;
  const zip = await JSZip.loadAsync(docx);
  let doc = await zip.file("word/document.xml")!.async("string");
  const overrides: [string, string][] = [];
  const rels: { id: string; type: string; target: string }[] = [];
  charts.forEach((def, i) => {
    const token = `@@CHART:${i}@@`;
    const at = doc.indexOf(token);
    if (at < 0) return;
    const ps = Math.max(doc.lastIndexOf("<w:p>", at), doc.lastIndexOf("<w:p ", at));
    const pe = doc.indexOf("</w:p>", at) + "</w:p>".length;
    const n = i + 1, rid = `rIdChart${n}`;
    zip.file(`word/charts/chart${n}.xml`, chartXml(def));
    overrides.push([`/word/charts/chart${n}.xml`, CT_CHART]);
    rels.push({ id: rid, type: REL_CHART, target: `charts/chart${n}.xml` });
    const cx = 5400000, cy = 3060000;
    const drawing = `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${1000 + n}" name="Chart ${n}"/><wp:cNvGraphicFramePr/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${rid}"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    doc = doc.slice(0, ps) + drawing + doc.slice(pe);
  });
  if (!/xmlns:wp=/.test(doc)) doc = doc.replace("<w:document ", '<w:document xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ');
  zip.file("word/document.xml", doc);
  await addRels(zip, "word/_rels/document.xml.rels", rels);
  await addContentTypes(zip, overrides);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/* ---- glue for the converters ---- */

import { cellValue, colLetter, type Sheet } from "./sheetmodel.js";

/** Chart definitions per sheet (by sheet position), in the order they were written; the sheet is the `##` section holding the block. */
export function chartsBySheet(md: string, sheets: Sheet[]): Map<number, ChartDef[]> {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const starts: { line: number; titled: boolean; hasTable: boolean }[] = [{ line: -1, titled: false, hasTable: false }];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { fence = !fence; continue; }
    if (fence) continue;
    if (/^##(?!#)\s+/.test(lines[i])) starts.push({ line: i, titled: true, hasTable: false });
    else if (lines[i].includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes("|")) starts[starts.length - 1].hasTable = true;
  }
  const kept = starts.map((s, idx) => ({ ...s, idx })).filter((s) => s.titled || s.hasTable);
  const out = new Map<number, ChartDef[]>();
  for (const b of findChartBlocks(md)) {
    const def = parseChartJson(b.raw);
    if (!def) continue;
    let sec = 0;
    for (let k = 0; k < starts.length; k++) if (starts[k].line < b.start) sec = k;
    const pos = kept.findIndex((s) => s.idx === sec);
    const sheetIdx = pos >= 0 ? pos : Math.max(0, Math.min(sheets.length - 1, kept.findIndex((s) => s.idx > sec) - 1));
    if (sheetIdx < 0 || sheetIdx >= sheets.length) continue;
    out.set(sheetIdx, [...(out.get(sheetIdx) ?? []), def]);
  }
  return out;
}

/** Fills a chart without its own data from the sheet's table: first column = categories, numeric columns = series. */
export function bindToSheet(def: ChartDef, sh: Sheet): { def: ChartDef; refs?: ChartRefs } | null {
  if (def.categories && def.series) return { def };
  const start = sh.header ? 1 : 0;
  const data = sh.rows.slice(start).filter((r) => r.some((c) => c !== ""));
  if (data.length < 1 || (sh.rows[0]?.length ?? 0) < 2) return null;
  const q = `'${sh.name.replace(/'/g, "''")}'`;
  const first = start + 1, last = start + data.length;
  const numeric = (c: number) => data.every((r) => { const t = cellValue(r[c] ?? "").t; return t === "number" || t === "formula"; });
  const cols: number[] = [];
  for (let c = 1; c < (sh.rows[0]?.length ?? 0) && cols.length < MAX_SERIES; c++) if (numeric(c)) cols.push(c);
  if (!cols.length) return null;
  const value = (s: string): number => { const v = cellValue(s); return v.t === "number" ? v.v : 0; };
  return {
    def: {
      ...def,
      categories: data.map((r) => r[0] ?? ""),
      series: cols.map((c) => ({ name: sh.header ? sh.rows[0][c] : `Series ${c}`, values: data.map((r) => value(r[c] ?? "")) })),
    },
    refs: {
      catRef: `${q}!$A$${first}:$A$${last}`,
      series: cols.map((c) => ({ nameRef: `${q}!$${colLetter(c)}$1`, valRef: `${q}!$${colLetter(c)}$${first}:$${colLetter(c)}$${last}` })),
    },
  };
}
