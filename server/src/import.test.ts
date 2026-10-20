import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, LevelFormat, AlignmentType } from "docx";
import ExcelJS from "exceljs";
import PptxGenJS from "pptxgenjs";

// Auth and the database are loaded lazily so DATA_DIR / DB_PATH point at a throwaway folder.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omni-import-"));
process.env.DB_PATH = join(process.env.DATA_DIR, "t.db");
const { importDocument, parseCsv, decodeWords, registerImportRoutes } = await import("./artifacts-import.js");
const { AuthError, createUserDirect, createDevice } = await import("./auth.js");
const { RICH_CONTENT_NOTE } = await import("./prompts.js");
const Fastify = (await import("fastify")).default;

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const utf8Qp = (s: string) => [...Buffer.from(s, "utf8")]
  .map((b) => (b >= 0x21 && b <= 0x7e && b !== 0x3d ? String.fromCharCode(b) : "=" + b.toString(16).toUpperCase().padStart(2, "0")))
  .join("");

/* ---------------- fixtures ---------------- */

async function makeDocx(): Promise<Buffer> {
  const cell = (t: string) => new TableCell({ children: [new Paragraph({ children: [new TextRun(t)] })] });
  const doc = new Document({
    numbering: { config: [{ reference: "steps", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT }] }] },
    sections: [{
      children: [
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Report")] }),
        new Paragraph({ children: [new TextRun("Plain "), new TextRun({ text: "bold", bold: true }), new TextRun(" and "), new TextRun({ text: "ital", italics: true }), new TextRun(".")] }),
        new Paragraph({ bullet: { level: 0 }, children: [new TextRun("first bullet")] }),
        new Paragraph({ numbering: { reference: "steps", level: 0 }, children: [new TextRun("step one")] }),
        new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("Data")] }),
        new Table({ rows: [new TableRow({ children: [cell("Name"), cell("Score")] }), new TableRow({ children: [cell("a|b"), cell("9")] })] }),
      ],
    }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

async function makeXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const s1 = wb.addWorksheet("Sales");
  s1.addRow(["Item", "Qty", "Price", "Total"]);
  s1.addRow(["Apple", 2, 100, { formula: "B2*C2" }]);
  s1.addRow(["Pear", 3, 50, { formula: "B3*C3" }]);
  s1.addRow(["Sum", { formula: "SUM(B2:B3)" }, "", { formula: "SUM(D2:D3)" }]);
  const s2 = wb.addWorksheet("Notes");
  s2.addRow(["Memo"]);
  s2.addRow(["ok"]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function makePptx(): Promise<Buffer> {
  const p: any = new (PptxGenJS as unknown as new () => any)();
  const s1 = p.addSlide();
  s1.addText("Roadmap", { x: 0.5, y: 0.3, w: 9, h: 1, fontSize: 32 });
  s1.addText([{ text: "Ship import", options: { bullet: true } }, { text: "Write tests", options: { bullet: true } }], { x: 0.5, y: 1.5, w: 9, h: 3 });
  const s2 = p.addSlide();
  s2.addText("Second", { x: 0.5, y: 0.3, w: 9, h: 1, fontSize: 32 });
  s2.addText("Only body", { x: 0.5, y: 1.5, w: 9, h: 1, bullet: true });
  return Buffer.from(await p.write({ outputType: "nodebuffer" }) as ArrayBuffer);
}

/* ---------------- docx ---------------- */

test("docx: headings, emphasis, bullets, numbered items and tables become Markdown", async () => {
  const r = await importDocument("Quarterly report.docx", await makeDocx());
  assert.equal(r.type, "docx");
  assert.equal(r.title, "Quarterly report");
  assert.equal(r.content, [
    "# Report",
    "",
    "Plain **bold** and *ital*.",
    "",
    "- first bullet",
    "1. step one",
    "",
    "## Data",
    "",
    "| Name | Score |",
    "| --- | --- |",
    "| a/b | 9 |",
  ].join("\n"));
});

/* ---------------- xlsx / csv ---------------- */

test("xlsx: one ## section per sheet, formulas kept as =text, numbers plain", async () => {
  const r = await importDocument("book.xlsx", await makeXlsx());
  assert.equal(r.type, "xlsx");
  assert.equal(r.content, [
    "## Sales",
    "",
    "| Item | Qty | Price | Total |",
    "| --- | --- | --- | --- |",
    "| Apple | 2 | 100 | =B2*C2 |",
    "| Pear | 3 | 50 | =B3*C3 |",
    "| Sum | =SUM(B2:B3) |  | =SUM(D2:D3) |",
    "",
    "## Notes",
    "",
    "| Memo |",
    "| --- |",
    "| ok |",
  ].join("\n"));
});

test("csv: RFC 4180 quoting, embedded newline, BOM and CRLF handled; becomes one Sheet1 xlsx section", async () => {
  const csv = "﻿Name,Note,Amount\r\n\"Smith, J\",\"He said \"\"hi\"\"\",1200\r\n\"Multi\nline\",x,3\r\n";
  const r = await importDocument("list.csv", Buffer.from(csv, "utf8"));
  assert.equal(r.type, "xlsx");
  assert.equal(r.title, "list");
  assert.equal(r.content, [
    "## Sheet1",
    "",
    "| Name | Note | Amount |",
    "| --- | --- | --- |",
    "| Smith, J | He said \"hi\" | 1200 |",
    "| Multi line | x | 3 |",
  ].join("\n"));
});

test("parseCsv keeps empty fields and drops blank lines", () => {
  assert.deepEqual(parseCsv("a,,c\n\n,\"\"\n"), [["a", "", "c"], ["", ""]]);
});

test("csv in Shift_JIS is decoded when it is not valid UTF-8", async () => {
  // "名前,値" in Shift_JIS: 96 BC 91 4F 2C 92 6C
  const r = await importDocument("sjis.csv", Buffer.from([0x96, 0xbc, 0x91, 0x4f, 0x2c, 0x92, 0x6c, 0x0a, 0x31, 0x2c, 0x32, 0x0a]));
  assert.equal(r.content, "## Sheet1\n\n| 名前 | 値 |\n| --- | --- |\n| 1 | 2 |");
});

/* ---------------- pptx ---------------- */

test("pptx: each slide becomes a ## section, first text is the title, the rest are bullets", async () => {
  const r = await importDocument("deck.pptx", await makePptx());
  assert.equal(r.type, "pptx");
  assert.equal(r.content, "## Roadmap\n- Ship import\n- Write tests\n\n## Second\n- Only body");
});

/* ---------------- eml ---------------- */

test("eml: multipart QP body in UTF-8, RFC 2047 subject and To, HTML part ignored", async () => {
  const body = "お世話になっております。\n見積もりを送ります。";
  const eml = [
    "From: Bob <bob@example.com>",
    "To: =?UTF-8?Q?Kai=20Tanaka?= <kai@example.com>, carol@example.com",
    "Cc: dave@example.com",
    `Subject: =?UTF-8?B?${b64("見積もりの件")}?=`,
    "MIME-Version: 1.0",
    "Content-Type: multipart/alternative; boundary=\"XYZ\"",
    "",
    "--XYZ",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    utf8Qp(body),
    "--XYZ",
    "Content-Type: text/html; charset=UTF-8",
    "",
    "<p>html version</p>",
    "--XYZ--",
    "",
  ].join("\r\n");
  const r = await importDocument("reply.eml", Buffer.from(eml, "latin1"));
  assert.equal(r.type, "email");
  assert.equal(r.title, "reply");
  assert.equal(r.content, `To: Kai Tanaka <kai@example.com>, carol@example.com\nCc: dave@example.com\nSubject: 見積もりの件\n\n${body}`);
});

test("eml: adjacent encoded words join without a space; base64 single-part body", async () => {
  const subject = `=?UTF-8?B?${b64(Buffer.from("見積", "utf8"))}?= =?UTF-8?B?${b64(Buffer.from("もり", "utf8"))}?=`;
  const eml = `Subject: ${subject}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64("Hello\r\nWorld")}\r\n`;
  const r = await importDocument("b64.eml", Buffer.from(eml, "latin1"));
  assert.equal(r.content, "Subject: 見積もり\n\nHello\nWorld");
});

test("eml: iso-2022-jp body is decoded with its charset", async () => {
  const jis = Buffer.from("\x1b$B$3$s$K$A$O\x1b(B", "latin1");
  const eml = `Subject: hi\r\nContent-Type: text/plain; charset=iso-2022-jp\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${jis.toString("latin1")}`;
  const r = await importDocument("jis.eml", Buffer.from(eml, "latin1"));
  assert.equal(r.content, "Subject: hi\n\nこんにちは");
});

test("eml: HTML-only message is reduced to text and attachments are skipped", async () => {
  const eml = [
    "To: a@example.com",
    "Subject: html only",
    "Content-Type: multipart/mixed; boundary=B",
    "",
    "--B",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<div>Hi <b>there</b></div><p>Line &amp; more</p><style>x{}</style>",
    "--B",
    "Content-Type: text/plain",
    "Content-Disposition: attachment; filename=\"a.txt\"",
    "",
    "should not appear",
    "--B--",
  ].join("\n");
  const r = await importDocument("html.eml", Buffer.from(eml, "latin1"));
  assert.equal(r.content, "To: a@example.com\nSubject: html only\n\nHi there\nLine & more");
});

test("decodeWords handles Q encoding with underscores", () => {
  assert.equal(decodeWords("=?ISO-8859-1?Q?Keld_J=F8rn_Simonsen?="), "Keld Jørn Simonsen");
});

/* ---------------- markdown / txt ---------------- */

test("md and txt are returned as markdown with BOM and CRLF normalised", async () => {
  const md = await importDocument("Notes.MD", Buffer.from("﻿# Title\r\n\r\nBody\r\n", "utf8"));
  assert.deepEqual(md, { type: "markdown", title: "Notes", content: "# Title\n\nBody" });
  const txt = await importDocument("plain.txt", Buffer.from("just text", "utf8"));
  assert.equal(txt.type, "markdown");
  assert.equal(txt.content, "just text");
});

test("importDocument: 415 for unknown extensions, 422 for corrupt office files", async () => {
  await assert.rejects(importDocument("evil.exe", Buffer.from("MZ")), (e: any) => e instanceof AuthError && e.status === 415);
  await assert.rejects(importDocument("broken.docx", Buffer.from("not a zip")), (e: any) => e instanceof AuthError && e.status === 422);
  await assert.rejects(importDocument("broken.xlsx", Buffer.from("not a zip")), (e: any) => e instanceof AuthError && e.status === 422);
  await assert.rejects(importDocument("broken.pptx", Buffer.from("not a zip")), (e: any) => e instanceof AuthError && e.status === 422);
});

test("RICH_CONTENT_NOTE tells the model about xlsx and email blocks", () => {
  assert.match(RICH_CONTENT_NOTE, /type=markdown\|html\|docx\|pptx\|xlsx\|email/);
  assert.match(RICH_CONTENT_NOTE, /=SUM\(B2:B9\)/);
  assert.match(RICH_CONTENT_NOTE, /\[要確認: \.\.\.\]/);
});

/* ---------------- route ---------------- */

const { token } = await (async () => {
  const u = await createUserDirect("importer", "password123", false);
  return createDevice(u.userId, "import-test");
})();

function makeApp() {
  const app = Fastify();
  app.setErrorHandler((err: any, _req, reply) => {
    const status = err instanceof AuthError ? err.status : err.statusCode ?? 500;
    reply.status(status).send({ error: err.message ?? "Internal error" });
  });
  registerImportRoutes(app);
  return app;
}

const post = (app: ReturnType<typeof makeApp>, payload: unknown, auth = `Bearer ${token}`) =>
  app.inject({ method: "POST", url: "/artifacts/import", headers: { ...(auth ? { authorization: auth } : {}) }, payload: payload as any });

test("POST /artifacts/import returns type, title and content", async () => {
  const app = makeApp();
  const res = await post(app, { filename: "Memo.md", data: b64("# Hi\n\nthere") });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { type: "markdown", title: "Memo", content: "# Hi\n\nthere" });
  const docx = await post(app, { filename: "report.docx", data: (await makeDocx()).toString("base64") });
  assert.equal(docx.statusCode, 200);
  assert.equal(docx.json().type, "docx");
  await app.close();
});

test("POST /artifacts/import: 401 without a token", async () => {
  const app = makeApp();
  const res = await post(app, { filename: "a.md", data: b64("x") }, "");
  assert.equal(res.statusCode, 401);
  await app.close();
});

test("POST /artifacts/import: 400 for bad base64 and missing fields", async () => {
  const app = makeApp();
  assert.equal((await post(app, { filename: "a.md", data: "@@@@" })).statusCode, 400);
  assert.equal((await post(app, { filename: "a.md", data: "abc" })).statusCode, 400);
  assert.equal((await post(app, { filename: "a.md" })).statusCode, 400);
  assert.equal((await post(app, { data: b64("x") })).statusCode, 400);
  await app.close();
});

test("POST /artifacts/import: 413 for more than 5 MB decoded", async () => {
  const app = makeApp();
  const res = await post(app, { filename: "big.txt", data: Buffer.alloc(5_000_001, 97).toString("base64") });
  assert.equal(res.statusCode, 413);
  await app.close();
});

test("POST /artifacts/import: 415 for .exe and 422 for a corrupt .docx", async () => {
  const app = makeApp();
  assert.equal((await post(app, { filename: "setup.exe", data: b64("MZ") })).statusCode, 415);
  assert.equal((await post(app, { filename: "broken.docx", data: b64("definitely not a zip file") })).statusCode, 422);
  await app.close();
});
