import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { startServer, api, type TestServer } from "./test-server.js";
import { parseSheets, cellValue, colLetter } from "./sheetmodel.js";
import { markdownToXlsx } from "./artifacts.js";

/* Office artifacts (server part): sheet model, .xlsx writer and POST /artifacts/convert for xlsx. */

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/* ---------------- parseSheets (pure) ---------------- */

test("parseSheets: each ## heading is a sheet, # headings are ignored, rows of all tables join with a blank row", () => {
  const sheets = parseSheets("# Report\n\nintro text\n\n## Sales\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n| C |\n|---|\n| 3 |\n\n## Notes\n\n| x |\n|---|\n| y |\n");
  assert.deepEqual(sheets.map((s) => s.name), ["Sales", "Notes"]);
  assert.deepEqual(sheets[0].rows, [["A", "B"], ["1", "2"], ["", ""], ["C", ""], ["3", ""]]);
  assert.equal(sheets[0].header, true);
  assert.deepEqual(sheets[1].rows, [["x"], ["y"]]);
});

test("parseSheets: tables before the first ## become Sheet1; plain text gives no sheet", () => {
  assert.deepEqual(parseSheets("| a | b |\n|---|---|\n| 1 | 2 |\n").map((s) => s.name), ["Sheet1"]);
  assert.deepEqual(parseSheets("just text\n\nmore text\n"), []);
});

test("parseSheets: an all-empty first header row means no header and the row is dropped", () => {
  const [s] = parseSheets("## Blank\n\n|  |  |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n");
  assert.equal(s.header, false);
  assert.deepEqual(s.rows, [["1", "2"], ["3", "4"]]);
});

test("parseSheets: cells lose inline ** __ and ` markers and are trimmed", () => {
  const [s] = parseSheets("## Styled\n\n| **Name** | `code` |\n|---|---|\n|  __x__  | y |\n");
  assert.deepEqual(s.rows, [["Name", "code"], ["x", "y"]]);
});

test("parseSheets: names are sanitized, truncated to 31 characters, deduplicated and never empty", () => {
  const sheets = parseSheets(
    "## a[b]:c*d?e/f\\g\n\n| x |\n|---|\n| 1 |\n\n" +
    "## " + "x".repeat(40) + "\n\n| x |\n|---|\n| 1 |\n\n" +
    "## Sales\n\n| x |\n|---|\n| 1 |\n\n" +
    "## sales\n\n| x |\n|---|\n| 1 |\n\n" +
    "## Sales\n\n| x |\n|---|\n| 1 |\n\n" +
    "## []\n\n| x |\n|---|\n| 1 |\n",
  );
  const names = sheets.map((s) => s.name);
  assert.equal(names[0], "abcdefg");
  assert.equal(names[1], "x".repeat(31));
  assert.deepEqual(names.slice(2, 5), ["Sales", "sales 2", "Sales 3"]);
  assert.equal(names[5], "Sheet6");
  for (const n of names) assert.ok(n.length >= 1 && n.length <= 31, n);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length, "all names unique");
});

test("cellValue: formulas, numbers, thousands separators, percentages and text", () => {
  assert.deepEqual(cellValue("=SUM(B2:B9)"), { t: "formula", f: "SUM(B2:B9)" });
  assert.deepEqual(cellValue("="), { t: "text", v: "=" });
  assert.deepEqual(cellValue("42"), { t: "number", v: 42 });
  assert.deepEqual(cellValue("-3.5"), { t: "number", v: -3.5 });
  assert.deepEqual(cellValue("1,234.5"), { t: "number", v: 1234.5 });
  assert.deepEqual(cellValue("12%"), { t: "number", v: 0.12 });
  assert.deepEqual(cellValue("1.2.3"), { t: "text", v: "1.2.3" });
  assert.deepEqual(cellValue("abc"), { t: "text", v: "abc" });
  assert.deepEqual(cellValue(""), { t: "text", v: "" });
});

test("colLetter: 0 is A, 25 is Z, 26 is AA, 701 is ZZ", () => {
  assert.equal(colLetter(0), "A");
  assert.equal(colLetter(25), "Z");
  assert.equal(colLetter(26), "AA");
  assert.equal(colLetter(701), "ZZ");
});

/* ---------------- markdownToXlsx (round trip through exceljs) ---------------- */

const SHEET_MD = "# Budget\n\n## Sales\n\n| Item | Qty |\n|---|---|\n| Apple | 2 |\n| Pear | 3 |\n| Total | =SUM(B2:B3) |\n\n## Notes\n\n| Note |\n|---|\n| 台湾の注記 |\n";

test("markdownToXlsx writes one worksheet per sheet with typed cells, bold header, frozen row and widths", async () => {
  const buf = await markdownToXlsx(SHEET_MD, "Budget");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ["Sales", "Notes"]);

  const ws = wb.getWorksheet("Sales")!;
  assert.equal(ws.getCell("A1").value, "Item");
  assert.equal(ws.getCell("A1").font?.bold, true, "header is bold");
  assert.equal(ws.getCell("A2").font?.bold, undefined, "body is not bold");
  assert.equal(typeof ws.getCell("B2").value, "number");
  assert.equal(ws.getCell("B2").value, 2);
  assert.equal(ws.getCell("B4").formula, "SUM(B2:B3)");
  assert.equal(ws.views[0].state, "frozen");
  assert.equal(ws.views[0].ySplit, 1);
  assert.ok((ws.getColumn(1).width ?? 0) >= 8, "minimum width");
  assert.ok((wb.getWorksheet("Notes")!.getColumn(1).width ?? 0) >= 2 * "台湾の注記".length, "CJK counts double");
});

test("markdownToXlsx without tables still produces a loadable workbook", async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await markdownToXlsx("just text", "Empty")) as any);
  assert.equal(wb.worksheets.length, 1);
});

/* ---------------- HTTP: POST /artifacts/convert ---------------- */

let srv: TestServer;
let token = "";
before(async () => {
  srv = await startServer();
  token = (await api(srv.base, "POST", "/auth/register", { username: "office", password: "password123" })).json.token as string;
});
after(() => { srv?.stop(); });

const convert = (body: unknown, tok: string | null = token) => fetch(`${srv.base}/artifacts/convert`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
  body: JSON.stringify(body),
});

test("POST /artifacts/convert type xlsx returns a loadable workbook with the right headers", async () => {
  const r = await convert({ type: "xlsx", title: "Budget 2026", markdown: SHEET_MD });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), XLSX_MIME);
  assert.equal(r.headers.get("content-disposition"), "attachment; filename*=UTF-8''Budget%202026.xlsx");
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(0, 4).toString("hex"), "504b0304", "zip signature");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ["Sales", "Notes"]);
  assert.equal(wb.getWorksheet("Sales")!.getCell("B4").formula, "SUM(B2:B3)");
});

test("POST /artifacts/convert xlsx without a title uses the spreadsheet stem", async () => {
  const r = await convert({ type: "xlsx", markdown: "## Data\n\n| a |\n|---|\n| 1 |\n" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-disposition"), "attachment; filename*=UTF-8''spreadsheet.xlsx");
});

test("POST /artifacts/convert xlsx without auth is 401", async () => {
  const r = await convert({ type: "xlsx", markdown: "## Data\n\n| a |\n|---|\n| 1 |\n" }, null);
  assert.equal(r.status, 401);
});

test("POST /artifacts/convert still returns docx and pptx, and rejects unknown types", async () => {
  const d = await convert({ type: "docx", title: "Doc", markdown: "# Hi\n\ntext" });
  assert.equal(d.status, 200);
  assert.equal(d.headers.get("content-type"), DOCX_MIME);
  const p = await convert({ type: "pptx", title: "Deck", markdown: "## One\n- a\n" });
  assert.equal(p.status, 200);
  assert.equal(p.headers.get("content-type"), PPTX_MIME);
  const bad = await convert({ type: "csv", markdown: "x" });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /type must be docx, pptx or xlsx/);
});
