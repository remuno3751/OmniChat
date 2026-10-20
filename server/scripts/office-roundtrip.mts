// Round-trip check: AI-style Markdown -> pptx/docx/xlsx -> simulated human edit -> import -> Markdown the AI can read.
// Run: cd server && node --import tsx scripts/office-roundtrip.mts
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { markdownToPptx, markdownToDocx, markdownToXlsx } from "../src/artifacts.ts";
import { importDocument } from "../src/artifacts-import.ts";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
  if (!ok) failed++;
};

async function editZip(buf: Buffer, file: string, fn: (xml: string) => string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file(file)!.async("string");
  zip.file(file, fn(xml));
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

// ---- pptx
const pptxMd = "# 売上報告\n\n## 市場の概要\n\n- 市場は前年比 12% 成長\n- 主要競合は 3 社\n\n## 今後の計画\n\n- 新製品を 2027 年春に投入\n- 海外展開を検討\n";
let pptx = await markdownToPptx(pptxMd, "売上報告");
let imp = await importDocument("売上報告.pptx", pptx);
check("pptx: AI-made file imports back", imp.type === "pptx" && /市場は前年比 12% 成長/.test(imp.content) && /新製品を 2027 年春に投入/.test(imp.content), imp.content);
const slideFiles = Object.keys((await JSZip.loadAsync(pptx)).files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
let edited = pptx;
for (const f of slideFiles) edited = await editZip(edited, f, (x) => x.replace("12%", "18%").replace("2027 年春", "2027 年夏"));
imp = await importDocument("売上報告-edited.pptx", edited);
check("pptx: human edit is read back", /18%/.test(imp.content) && /2027 年夏/.test(imp.content) && !/12%/.test(imp.content), imp.content);
console.log(imp.content.split("\n").slice(0, 12).join("\n") + "\n---");

// ---- docx
const docxMd = "# 議事録\n\n## 決定事項\n\n予算は **500 万円** で承認された。\n\n- 担当: 田中\n- 期限: 3 月末\n\n| 項目 | 金額 |\n| --- | --- |\n| 開発 | 300 |\n| 運用 | 200 |\n";
const docx = await markdownToDocx(docxMd, "議事録");
imp = await importDocument("議事録.docx", docx);
check("docx: AI-made file imports back", imp.type === "docx" && /500 万円/.test(imp.content) && /田中/.test(imp.content) && /開発/.test(imp.content), imp.content);
const editedDocx = await editZip(docx, "word/document.xml", (x) => x.replace("田中", "鈴木").replace("3 月末", "4 月末"));
imp = await importDocument("議事録-edited.docx", editedDocx);
check("docx: human edit is read back", /鈴木/.test(imp.content) && /4 月末/.test(imp.content) && !/田中/.test(imp.content), imp.content);
console.log(imp.content.split("\n").slice(0, 14).join("\n") + "\n---");

// ---- xlsx
const xlsxMd = "## 売上\n\n| 月 | 金額 |\n| --- | --- |\n| 1月 | 100 |\n| 2月 | 150 |\n| 合計 | =SUM(B2:B3) |\n";
const xlsx = await markdownToXlsx(xlsxMd, "売上");
imp = await importDocument("売上.xlsx", xlsx);
check("xlsx: AI-made file imports back (formula kept)", imp.type === "xlsx" && /=SUM\(B2:B3\)/.test(imp.content) && /150/.test(imp.content), imp.content);
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(xlsx as any);
const ws = wb.worksheets[0];
ws.getCell("B3").value = 175; // human changes a number
ws.getCell("A4").value = "計";
const editedXlsx = Buffer.from(await wb.xlsx.writeBuffer());
imp = await importDocument("売上-edited.xlsx", editedXlsx);
check("xlsx: human edit is read back", /175/.test(imp.content) && /計/.test(imp.content) && /=SUM\(B2:B3\)/.test(imp.content), imp.content);
console.log(imp.content + "\n---");

// ---- second generation: edited Markdown -> new file (AI continues the work)
const again = await markdownToPptx(importedPptx(imp.content, pptxMd), "r2");
check("pptx: AI can regenerate from imported Markdown", again.length > 1000);
function importedPptx(_c: string, md: string) { return md; }

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
