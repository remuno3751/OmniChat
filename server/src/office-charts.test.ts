import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { markdownToDocx, markdownToXlsx } from "./artifacts.js";
import { parseChartJson, findChartBlocks, chartXml } from "./office-charts.js";

const XLSX_MD = [
  "## Sales", "| Item | Jan | Feb | Mar |", "|---|---|---|---|",
  "| A | 10 | 20 | 30 |", "| B | 5 | 15 | 25 |", "",
  "```chart", '{"type":"column","title":"Sales by item"}', "```",
  "", "## Plain", "| x | y |", "|---|---|", "| 1 | 2 |",
].join("\n");

test("parseChartJson: chat charts (bar = vertical), literal data, bad input", () => {
  const d = parseChartJson('{"type":"bar","title":"T","labels":["a","b"],"series":[{"name":"s","data":[1,2]}]}')!;
  assert.equal(d.kind, "column");
  assert.deepEqual(d.series, [{ name: "s", values: [1, 2] }]);
  assert.equal(parseChartJson('{"type":"line"}')!.categories, undefined, "no data: bound to the sheet later");
  assert.equal(parseChartJson("not json"), null);
  assert.equal(parseChartJson('{"type":"radar"}'), null);
});

test("findChartBlocks: finds fences with their line range", () => {
  const b = findChartBlocks("a\n```chart\n{}\n```\nb");
  assert.deepEqual(b.map((x) => [x.start, x.end, x.raw]), [[1, 3, "{}"]]);
});

test("xlsx: a chart block under a sheet becomes a native chart bound to that sheet's table", async () => {
  const buf = await markdownToXlsx(XLSX_MD, "t");
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files);
  assert.ok(names.includes("xl/charts/chart1.xml"));
  assert.ok(names.some((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n)));
  const chart = await zip.file("xl/charts/chart1.xml")!.async("string");
  assert.match(chart, /<c:barChart>/);
  assert.match(chart, /'Sales'!\$A\$2:\$A\$3/, "categories read the first column");
  assert.match(chart, /'Sales'!\$B\$2:\$B\$3/, "a series per numeric column");
  assert.match(chart, /<c:v>Sales by item<\/c:v>|Sales by item/);
  const ct = await zip.file("[Content_Types].xml")!.async("string");
  assert.match(ct, /drawingml\.chart\+xml/);
  assert.match(ct, /drawing\+xml/);
  const sheet1 = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  assert.match(sheet1, /<drawing r:id="rIdChartDrawing"\/><\/worksheet>/);
  assert.ok(!(await zip.file("xl/worksheets/sheet2.xml")!.async("string")).includes("<drawing"), "the other sheet has none");
  // the workbook still opens and keeps its cells
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  assert.equal(wb.getWorksheet("Sales")!.getCell("C3").value, 15);
});

test("docx: a chart block with data becomes a native inline chart; one without data is dropped", async () => {
  const md = [
    "# Report", "", "Intro", "",
    "```chart", '{"type":"pie","title":"Share","labels":["a","b"],"series":[{"name":"s","data":[3,1]}]}', "```", "",
    "```chart", '{"type":"line"}', "```", "", "After",
  ].join("\n");
  const buf = await markdownToDocx(md, "t");
  const zip = await JSZip.loadAsync(buf);
  assert.ok(zip.file("word/charts/chart1.xml"));
  assert.ok(!zip.file("word/charts/chart2.xml"));
  const doc = await zip.file("word/document.xml")!.async("string");
  assert.match(doc, /<c:chart [^>]*r:id="rIdChart1"/);
  assert.ok(!doc.includes("@@CHART"), "no placeholder is left");
  assert.match(doc, /After/);
  assert.match(await zip.file("word/_rels/document.xml.rels")!.async("string"), /charts\/chart1\.xml/);
  assert.match(await zip.file("word/charts/chart1.xml")!.async("string"), /<c:pieChart>/);
});

test("chartXml: every kind produces its chart element and escapes text", () => {
  for (const [kind, tag] of [["column", "barChart"], ["bar", "barChart"], ["line", "lineChart"], ["pie", "pieChart"], ["doughnut", "doughnutChart"], ["area", "areaChart"]] as const) {
    const x = chartXml({ kind, title: "A & <B>", categories: ["x"], series: [{ name: "s", values: [1] }] });
    assert.match(x, new RegExp(`<c:${tag}>`));
    assert.match(x, /A &amp; &lt;B&gt;/);
  }
});

test("every part written for charts is well-formed XML", async () => {
  const { SaxesParser } = await import("saxes");
  const wellFormed = (name: string, xml: string) => {
    const p = new SaxesParser({ xmlns: true });
    p.on("error", (e: Error) => assert.fail(`${name}: ${e.message}`));
    p.write(xml).close();
  };
  const md = [XLSX_MD, "", "```chart", '{"type":"line","title":"L","labels":["a"],"series":[{"name":"s","data":[1]}]}', "```"].join("\n");
  for (const [kind, buf] of [["xlsx", await markdownToXlsx(md, "t")], ["docx", await markdownToDocx(md, "t")]] as const) {
    const zip = await JSZip.loadAsync(buf);
    for (const n of Object.keys(zip.files)) if (/\.(xml|rels)$/.test(n)) wellFormed(`${kind}:${n}`, await zip.file(n)!.async("string"));
  }
});
