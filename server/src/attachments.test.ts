// Attachments (docs/design/ATTACHMENTS.md). One server for the file, run in order. Pure modules are imported directly;
// modules that touch the database are imported after the test sets DATA_DIR / DB_PATH to the server's folder (same file).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";
import ExcelJS from "exceljs";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { startServer, api, type TestServer } from "./test-server.js";
import { detectType, sanitizeFileName } from "./attachments-types.js";
import { extractAttachmentText } from "./attachments-extract.js";
import { visionFromMeta, visionSupport } from "./vision.js";

const PW = "password123";
const MB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const KEY = "sk-test-KEY-123";
const TRANSCRIPT = "fake transcript";

let s: TestServer;
let boss = "", bob = "", provId = "";
let fake: Server;
let fakePort = 0;
let fakeStatus = 200;
const fakeSeen: { auth?: string; path: string; body: string }[] = [];
let att: any; // ./attachments.js (loaded after the environment is set)
let ret: any; // ./attachments-retention.js
let settings: any; // ./attachments-settings.js

const DOC = "Hello DOCX attachment";
const PPT = "Hello PPTX slide";
const NOTE = "Speaker note text";
const XLS = "Sheet cell value";

/** Raw request (binary-safe). */
async function raw(method: string, path: string, tok: string, body?: Buffer | string, headers: Record<string, string> = {}) {
  const r = await fetch(s.base + path, {
    method,
    headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...headers },
    body: body === undefined ? undefined : new Uint8Array(typeof body === "string" ? Buffer.from(body) : body),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(buf.toString("utf8")); } catch { /* not json */ }
  return { status: r.status, headers: r.headers, buf, json, text: buf.toString("utf8") };
}

/** Uploads one file. */
const upload = (tok: string, name: string, body: Buffer | string, mime = "application/octet-stream") =>
  raw("POST", "/attachments", tok, body, { "content-type": mime, "x-file-name": encodeURIComponent(name) });

const adminPut = (body: unknown) => api(s.base, "PUT", "/admin/attachments", body, boss);
const sub = (text: string) => Buffer.from(text, "utf8");

function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 20 60 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}`
    + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

async function docxBuf(): Promise<Buffer> {
  const doc = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun(DOC)] })] }] });
  return Buffer.from(await Packer.toBuffer(doc));
}
async function pptxBuf(): Promise<Buffer> {
  const pres = new (PptxGenJS as unknown as new () => any)();
  const slide = pres.addSlide();
  slide.addText(PPT, { x: 1, y: 1, w: 5, h: 1 });
  slide.addNotes(NOTE);
  return Buffer.from(await pres.write({ outputType: "nodebuffer" }) as ArrayBuffer);
}
async function xlsxBuf(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Data");
  ws.addRow(["name", "qty"]);
  ws.addRow([XLS, 3]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
/** A WAV header with a little audio. */
const wav = () => Buffer.concat([Buffer.from("RIFF"), Buffer.from([36, 0, 0, 0]), Buffer.from("WAVEfmt "), Buffer.alloc(40, 1)]);
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);

before(async () => {
  s = await startServer({ OMNICHAT_OPEN_FIRST_REGISTRATION: "1", ALLOW_REGISTRATION: "1" });
  boss = (await api(s.base, "POST", "/auth/register", { username: "boss", password: PW, deviceName: "t", platform: "test" })).json.token;
  bob = (await api(s.base, "POST", "/auth/register", { username: "bob", password: PW, deviceName: "t", platform: "test" })).json.token;
  assert.ok(boss && bob, "registration failed");
  fake = createServer((req, res) => {
    let b = "";
    req.setEncoding("latin1");
    req.on("data", (c) => { b += c; });
    req.on("end", () => {
      fakeSeen.push({ auth: req.headers.authorization, path: req.url ?? "", body: b });
      res.writeHead(fakeStatus, { "content-type": "application/json" });
      res.end(fakeStatus === 200 ? JSON.stringify({ text: TRANSCRIPT }) : JSON.stringify({ error: "upstream failed" }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  fakePort = (fake.address() as { port: number }).port;
  provId = crypto.randomUUID();
  const p = await api(s.base, "PUT", `/providers/${provId}`, { name: "Fake", kind: "openai-compatible", baseUrl: `http://127.0.0.1:${fakePort}/v1`, model: "whisper-1", apiKey: KEY }, boss);
  assert.equal(p.status, 200, "provider failed");
  // The in-process modules read the same database file as the server.
  process.env.DATA_DIR = s.tmp;
  process.env.DB_PATH = join(s.tmp, "t.db");
  att = await import("./attachments.js");
  ret = await import("./attachments-retention.js");
  settings = await import("./attachments-settings.js");
});
after(() => { s?.stop(); fake?.close(); });

test("a. upload, read back, delete; meta and status", async () => {
  const r = await upload(boss, "note.txt", sub("hello world\n"), "text/plain");
  assert.equal(r.status, 200, r.text);
  const a = r.json.attachment;
  assert.equal(a.name, "note.txt");
  assert.equal(a.kind, "document");
  assert.equal(a.mime, "text/plain");
  assert.equal(a.size, 12);
  assert.equal(a.status, "ready");
  assert.equal(a.textChars, 12);
  const g = await raw("GET", `/attachments/${a.id}`, boss);
  assert.equal(g.status, 200);
  assert.equal(g.text, "hello world\n");
  const d = await raw("DELETE", `/attachments/${a.id}`, boss);
  assert.equal(d.status, 200);
  assert.equal((await raw("GET", `/attachments/${a.id}`, boss)).status, 410);
  assert.equal((await raw("DELETE", `/attachments/${a.id}`, boss)).status, 410);
  assert.equal(att.getAttachmentRow(a.id).status, "deleted");
});

test("b. other users get 404 for read, delete and list", async () => {
  const a = (await upload(boss, "private.txt", sub("secret"), "text/plain")).json.attachment;
  assert.equal((await raw("GET", `/attachments/${a.id}`, bob)).status, 404);
  assert.equal((await raw("DELETE", `/attachments/${a.id}`, bob)).status, 404);
  assert.equal((await raw("GET", `/attachments/${crypto.randomUUID()}`, bob)).status, 404);
  assert.equal((await raw("GET", "/attachments/not-an-id", bob)).status, 404);
  const bobList = (await raw("GET", "/attachments", bob)).json.attachments;
  assert.equal(bobList.some((x: any) => x.id === a.id), false);
  assert.equal((await raw("GET", "/attachments", boss)).json.attachments.some((x: any) => x.id === a.id), true);
  assert.equal((await raw("GET", "/attachments", "")).status, 401);
});

test("c. refused types: executables, disguised names, SVG, zip, mismatches", async () => {
  const mz = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(200, 0)]);
  const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60, 1)]);
  const cases: [string, Buffer | string, number?][] = [
    ["setup.exe", mz],
    ["tool.bat", "@echo off\r\n"],
    ["pic.png", mz],
    ["bin.txt", elf],
    ["image.svg", "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"],
    ["logo.png", "<svg xmlns='http://www.w3.org/2000/svg'></svg>"],
    ["data.zip", Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6])],
  ];
  const zipNoOffice = await new JSZip().file("readme.txt", "plain").generateAsync({ type: "nodebuffer" });
  cases.push(["notes.docx", zipNoOffice]);
  cases.push(["bad.txt", Buffer.from([0x68, 0x69, 0x00, 0x6f])]);
  cases.push(["plain.docx", sub("this is text, not a docx")]);
  cases.push(["photo.jpg", png()]);
  for (const [name, body] of cases) {
    const r = await upload(bob, name, body);
    assert.equal(r.status, 415, `${name}: ${r.status} ${r.text}`);
    assert.equal(r.json.code, "attachment_type_not_allowed", name);
  }
  assert.equal((await upload(bob, "empty.txt", Buffer.alloc(0), "text/plain")).status, 400);
});

test("d. size limit (413) and quota (507)", async () => {
  assert.equal((await adminPut({ maxFileMB: 1 })).status, 200);
  const big = Buffer.alloc(MB + 1024, 0x61);
  const r = await upload(boss, "big.txt", big, "text/plain");
  assert.equal(r.status, 413);
  assert.equal(r.json.code, "attachment_too_large");
  assert.equal((await adminPut({ maxFileMB: 25 })).status, 200);

  // bob has nothing stored yet: a quota of 1 MB takes one 600 KB file, then the next one does not fit.
  assert.equal((await adminPut({ quotaMB: 1 })).status, 200);
  const first = await upload(bob, "q1.txt", Buffer.alloc(600 * 1024, 0x62), "text/plain");
  assert.equal(first.status, 200, first.text);
  const second = await upload(bob, "q2.txt", Buffer.alloc(600 * 1024, 0x63), "text/plain");
  assert.equal(second.status, 507);
  assert.equal(second.json.code, "attachment_quota_exceeded");
  assert.equal((await adminPut({ quotaMB: 2048 })).status, 200);
});

test("d2. the size limit also holds for a chunked upload (no Content-Length)", async () => {
  assert.equal((await adminPut({ maxFileMB: 1 })).status, 200);
  try {
    const chunk = new Uint8Array(256 * 1024).fill(0x61);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) { if (sent >= 6) { c.close(); return; } sent++; c.enqueue(chunk); }, // 1.5 MB in 6 chunks
    });
    const r = await fetch(s.base + "/attachments", {
      method: "POST", body, duplex: "half",
      headers: { authorization: `Bearer ${boss}`, "content-type": "text/plain", "x-file-name": "chunked.txt" },
    } as RequestInit & { duplex: "half" });
    assert.equal(r.status, 413);
  } finally { assert.equal((await adminPut({ maxFileMB: 25 })).status, 200); }
});

test("e. file names are sanitised", async () => {
  const cases: [string, string][] = [
    ["..%2F..%2Fevil%00.txt", "evil.txt"],
    ["%E3%83%86%E3%82%B9%E3%83%88.txt", "テスト.txt"],
    ["%2E%2Ehidden.txt", "hidden.txt"],
    ["C%3A%5Cdir%5Cx.md", "x.md"],
  ];
  for (const [header, want] of cases) {
    const r = await raw("POST", "/attachments", boss, sub("x"), { "content-type": "text/plain", "x-file-name": header });
    assert.equal(r.status, 200, header);
    assert.equal(r.json.attachment.name, want, header);
  }
  const long = "a".repeat(300) + ".txt";
  const r = await upload(boss, long, sub("y"), "text/plain");
  assert.equal(r.status, 200);
  assert.ok(r.json.attachment.name.length <= 200);
  assert.ok(r.json.attachment.name.endsWith(".txt"));
  assert.equal(sanitizeFileName("a/b\\c\u0007d.pdf"), "cd.pdf");
});

test("f. extraction through the API: office files and pdf report characters", async () => {
  const cases: [string, Buffer, string][] = [
    ["doc.docx", await docxBuf(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["deck.pptx", await pptxBuf(), "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["sheet.xlsx", await xlsxBuf(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["paper.pdf", minimalPdf("Hello PDF"), "application/pdf"],
    ["readme.md", sub("# Title\n\nbody"), "text/markdown"],
    ["table.csv", sub("a,b\n1,2\n"), "text/csv"],
  ];
  for (const [name, body, mime] of cases) {
    const r = await upload(bob, name, body, mime);
    assert.equal(r.status, 200, `${name}: ${r.text}`);
    assert.ok(r.json.attachment.textChars > 0, `${name} has text`);
    assert.equal(r.text.includes(DOC) || r.text.includes(PPT) || r.text.includes(XLS), false, "extracted text is not echoed");
  }
});

test("g. extraction of each format (pure modules)", async () => {
  const docT = await extractAttachmentText(await detectType("doc.docx", await docxBuf()), await docxBuf());
  assert.ok(docT.text?.includes(DOC));
  const pb = await pptxBuf();
  const pptT = (await extractAttachmentText(await detectType("deck.pptx", pb), pb)).text ?? "";
  assert.match(pptT, /--- スライド 1 ---/);
  assert.ok(pptT.includes(PPT));
  assert.ok(pptT.includes(NOTE), "speaker notes");
  const xb = await xlsxBuf();
  const xlsT = (await extractAttachmentText(await detectType("sheet.xlsx", xb), xb)).text ?? "";
  assert.ok(xlsT.includes("--- シート: Data ---"));
  assert.ok(xlsT.includes(`${XLS}\t3`), "TSV row");
  const pdf = minimalPdf("Hello PDF");
  const pdfT = await extractAttachmentText(await detectType("paper.pdf", pdf), pdf);
  assert.match(pdfT.text ?? "", /--- ページ 1 ---/);
  assert.ok((pdfT.text ?? "").includes("Hello PDF"));
  const sj = Buffer.from("日本語のテキスト", "utf8");
  const shift = await extractAttachmentText(await detectType("a.txt", sj), sj);
  assert.equal(shift.text, "日本語のテキスト");
  const html = await extractAttachmentText(await detectType("p.html", sub("<p>Hi <b>there</b></p><script>x()</script>")), sub("<p>Hi <b>there</b></p><script>x()</script>"));
  assert.ok(html.text?.includes("Hi there") && !html.text.includes("x()"));
  const broken = Buffer.from("%PDF-1.4\nnot really a pdf");
  const bad = await extractAttachmentText(await detectType("broken.pdf", broken), broken);
  assert.ok(bad.warning, "a broken pdf gives a warning, not an exception");
});

test("h. vision: every branch of the metadata reading, and the user override", async () => {
  assert.equal(visionFromMeta({ architecture: { input_modalities: ["text", "image"] } }), "yes");
  assert.equal(visionFromMeta({ architecture: { input_modalities: ["text"] } }), "no");
  assert.equal(visionFromMeta({ modalities: { vision: true } }), "yes");
  assert.equal(visionFromMeta({ modalities: { vision: false } }), "no");
  assert.equal(visionFromMeta({ capabilities: ["completion", "vision"] }), "yes");
  assert.equal(visionFromMeta({ capabilities: ["completion"] }), "no");
  assert.equal(visionFromMeta({ vision: true }), "yes");
  assert.equal(visionFromMeta({ input: ["text", "image"] }), "yes");
  assert.equal(visionFromMeta({ id: "x" }), undefined);
  assert.equal(visionFromMeta(null), undefined);
  assert.equal(visionSupport({ id: "p1" }, "m", null), "unknown");
  assert.equal(visionSupport({ id: "p1" }, "m", { vision: "yes" }), "yes");
  assert.equal(visionSupport({ id: "p1" }, "m", { vision: "no" }), "no");
  assert.equal(visionSupport({ id: "p1" }, "m", { vision: "no" }, { "p1::m": true }), "yes", "override wins");
  assert.equal(visionSupport({ id: "p1" }, "m", { vision: "yes" }, { "p1::m": false }), "no");
  assert.equal(visionSupport({ id: "p1" }, "other", null, { "p1::m": true }), "unknown");
  const r = await api(s.base, "PUT", "/settings", { modelVision: { [`${provId}::whisper-1`]: true } }, boss);
  assert.equal(r.status, 200, r.text);
  const g = await api(s.base, "GET", "/settings", undefined, boss);
  assert.equal(g.json.settings?.modelVision?.[`${provId}::whisper-1`] ?? g.json.modelVision?.[`${provId}::whisper-1`], true);
  assert.equal((await api(s.base, "PUT", "/settings", { modelVision: "yes" }, boss)).status, 400);
  await api(s.base, "PUT", "/settings", { modelVision: null }, boss);
});

test("i. delivery headers: nosniff, inline images, attachment and sandbox for the rest", async () => {
  const p = (await upload(boss, "pic.png", png(), "image/png")).json.attachment;
  const gi = await raw("GET", `/attachments/${p.id}`, boss);
  assert.equal(gi.headers.get("content-type"), "image/png");
  assert.match(gi.headers.get("content-disposition") ?? "", /^inline/);
  assert.equal(gi.headers.get("x-content-type-options"), "nosniff");
  const t = (await upload(boss, "page.html", sub("<script>alert(1)</script>"), "text/html")).json.attachment;
  const gt = await raw("GET", `/attachments/${t.id}`, boss);
  assert.match(gt.headers.get("content-disposition") ?? "", /^attachment/);
  assert.equal(gt.headers.get("x-content-type-options"), "nosniff");
  assert.equal(gt.headers.get("content-security-policy"), "sandbox");
});

test("j. admin settings: validation, role check, audit", async () => {
  const g = await api(s.base, "GET", "/admin/attachments", undefined, boss);
  assert.equal(g.status, 200);
  assert.equal(g.json.attachments.maxFileMB, 25);
  assert.equal(g.json.attachments.retentionDays, 0);
  assert.equal((await api(s.base, "GET", "/admin/attachments", undefined, bob)).status, 403);
  assert.equal((await api(s.base, "PUT", "/admin/attachments", { maxFileMB: 3 }, bob)).status, 403);
  for (const body of [{ maxFileMB: 0 }, { maxFileMB: 501 }, { quotaMB: -1 }, { retentionDays: 3651 }, { maxPerMessage: 1.5 }, { extractMaxChars: 999 }, { transcribeModel: "no-separator" }, { unknown: 1 }, {}, [1]]) {
    assert.equal((await adminPut(body as any)).status, 400, JSON.stringify(body));
  }
  const ok = await adminPut({ maxFileMB: 30, transcribeModel: null });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.attachments.maxFileMB, 30);
  assert.equal((await adminPut({ maxFileMB: 25 })).json.attachments.maxFileMB, 25);
  const audit = await api(s.base, "GET", "/admin/audit?limit=50", undefined, boss);
  assert.ok(audit.json.entries?.some((e: any) => e.action === "attachments.update" && e.key === "maxFileMB") || audit.text.includes("attachments.update"));
});

test("k. transcription: key sent, text kept, failure keeps the audio", async () => {
  assert.equal((await adminPut({ transcribeModel: `${provId}::whisper-1` })).status, 200);
  const r = await upload(boss, "voice.wav", wav(), "audio/wav");
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.warnings, []);
  assert.equal(r.text.includes(TRANSCRIPT), false, "the transcript is not echoed");
  const last = fakeSeen[fakeSeen.length - 1]!;
  assert.equal(last.auth, `Bearer ${KEY}`);
  assert.equal(last.path, "/v1/audio/transcriptions");
  assert.match(last.body, /name="model"\r\n\r\nwhisper-1/);
  assert.equal(att.getAttachmentRow(r.json.attachment.id).transcript, TRANSCRIPT);

  fakeStatus = 500;
  const f = await upload(boss, "voice2.wav", wav(), "audio/wav");
  fakeStatus = 200;
  assert.equal(f.status, 200);
  assert.equal(f.json.warnings.length, 1);
  assert.equal(att.getAttachmentRow(f.json.attachment.id).transcript, null);
  assert.equal(f.text.includes(KEY), false, "no key in responses");
  assert.equal((await raw("GET", `/attachments/${f.json.attachment.id}`, boss)).status, 200, "audio is kept");

  assert.equal((await adminPut({ transcribeModel: null })).status, 200);
  const n = await upload(boss, "voice3.wav", wav(), "audio/wav");
  assert.equal(n.json.warnings.length, 1, "no model: a warning, the audio is kept");
});

test("l. retention: kept for ever by default, but unattached uploads go after 24 h; expired ones go at retentionDays", async () => {
  const keep = (await upload(bob, "keep.txt", sub("keep me"), "text/plain")).json.attachment;
  const owner = att.getAttachmentRow(keep.id).userId;
  assert.deepEqual(att.claimAttachments(owner, [keep.id], "conv-1", "msg-1"), { ok: true });
  const loose = (await upload(bob, "loose.txt", sub("loose"), "text/plain")).json.attachment;

  assert.deepEqual(ret.runRetention(Date.now() + 60 * 60 * 1000), { expired: 0, unattached: 0 }, "nothing is old enough after 1 h");
  assert.equal(att.getAttachmentRow(loose.id).status, "ready");
  // retentionDays 0 (default): attached files are kept for ever, but an upload never sent with a message still goes after 24 h
  const d0 = ret.runRetention(Date.now() + 25 * 60 * 60 * 1000);
  assert.equal(d0.expired, 0, "retentionDays 0 expires nothing");
  assert.ok(d0.unattached >= 1, "unattached after 24 h goes even with retentionDays 0");
  assert.equal(att.getAttachmentRow(loose.id).status, "deleted");
  assert.equal(att.getAttachmentRow(keep.id).status, "ready", "attached files are kept for ever at retentionDays 0");
  assert.deepEqual(ret.runRetention(Date.now() + 3650 * DAY).expired, 0, "still nothing expires at retentionDays 0");

  assert.equal((await adminPut({ retentionDays: 30 })).status, 200);
  const u = ret.runRetention(Date.now() + 25 * 60 * 60 * 1000);
  assert.equal(u.expired, 0, "nothing is expired at 30 days");
  assert.equal(att.getAttachmentRow(loose.id).status, "deleted");
  assert.equal(existsSync(join(s.tmp, "attachments", owner, loose.id)), false, "bytes removed");
  assert.equal(att.getAttachmentRow(keep.id).status, "ready", "attached and not yet expired");

  assert.ok(ret.runRetention(Date.now() + 31 * DAY).expired >= 1);
  assert.equal(att.getAttachmentRow(keep.id).status, "deleted");
  assert.equal(existsSync(join(s.tmp, "attachments", owner, keep.id)), false);
  assert.equal((await raw("GET", `/attachments/${keep.id}`, bob)).status, 410);
  assert.equal((await adminPut({ retentionDays: 0 })).status, 200);
});

test("m. the model path: images as data URLs, text cut to extractMaxChars, deleted gives null", async () => {
  const img = (await upload(boss, "m.png", png(), "image/png")).json.attachment;
  const im = att.loadAttachmentForModel(att.getAttachmentRow(img.id));
  assert.ok(im.dataUrl.startsWith("data:image/png;base64,"));
  assert.equal(att.attachmentMeta(att.getAttachmentRow(img.id)).kind, "image");
  assert.equal(att.userUsage(att.getAttachmentRow(img.id).userId).count >= 1, true);
  assert.equal((await adminPut({ extractMaxChars: 1000 })).status, 200);
  const long = (await upload(boss, "long.txt", sub("ab".repeat(1000)), "text/plain")).json.attachment;
  const t = att.loadAttachmentForModel(att.getAttachmentRow(long.id));
  assert.equal(t.text.length, 1000);
  assert.deepEqual(t.truncated, { total: 2000, shown: 1000 });
  assert.equal((await adminPut({ extractMaxChars: 60000 })).status, 200);
  assert.equal(att.loadAttachmentForModel({ ...att.getAttachmentRow(long.id), status: "deleted" }), null);
});
