// SHARED with server/src/sheetmodel.ts and app/src/sheetModel.ts - keep byte-identical
export interface Sheet { name: string; rows: string[][]; header: boolean }
export type CellValue = { t: "formula"; f: string } | { t: "number"; v: number } | { t: "text"; v: string };

interface RawTable { rows: string[][] }
interface RawSection { title: string | null; tables: RawTable[] }

const splitRow = (line: string): string[] => {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
};
const isSeparator = (line: string): boolean =>
  line.includes("|") && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
const clean = (cell: string): string => cell.replace(/\*\*|__|`/g, "").trim();

/** Excel sheet name: no []:*?/\ , trimmed, at most 31 characters, unique (case-insensitive). */
function sheetName(raw: string, index: number, used: Set<string>): string {
  let base = raw.replace(/[[\]:*?/\\]/g, "").trim().slice(0, 31).trim();
  if (!base) base = `Sheet${index}`;
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) {
    const suffix = ` ${n}`;
    name = `${base.slice(0, 31 - suffix.length).trim()}${suffix}`;
  }
  used.add(name.toLowerCase());
  return name;
}

/** Each `## Name` starts a sheet; tables before the first `##` form "Sheet1" when there are any. */
export function parseSheets(md: string): Sheet[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const sections: RawSection[] = [{ title: null, tables: [] }];
  let cur = sections[0];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h = /^##(?!#)\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      cur = { title: h[1], tables: [] };
      sections.push(cur);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const rows: string[][] = [splitRow(line)];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") rows.push(splitRow(lines[i++]));
      i--;
      cur.tables.push({ rows });
    }
  }

  const used = new Set<string>();
  const out: Sheet[] = [];
  for (const sec of sections) {
    if (sec.title === null && sec.tables.length === 0) continue;
    const name = sheetName(sec.title ?? "Sheet1", out.length + 1, used);
    // Each table contributes its rows; a blank separator row goes between tables.
    const groups: (string[][] | null)[] = [];
    sec.tables.forEach((t, ti) => {
      if (ti > 0) groups.push(null);
      let rows = t.rows.map((r) => r.map(clean));
      if (ti === 0 && rows[0].every((c) => c === "")) rows = rows.slice(1);
      groups.push(rows);
    });
    const header = sec.tables.length > 0 && sec.tables[0].rows[0].some((c) => clean(c) !== "");
    const width = Math.max(0, ...groups.flatMap((g) => (g ?? []).map((r) => r.length)));
    const rows: string[][] = [];
    for (const g of groups) {
      if (g === null) { if (rows.length) rows.push(Array(width).fill("")); continue; }
      for (const r of g) rows.push([...r, ...Array(width - r.length).fill("")]);
    }
    out.push({ name, rows, header: header && sec.tables.length > 0 });
  }
  return out;
}

const NUMBER = /^[+-]?(\d+(\.\d+)?|\d{1,3}(,\d{3})+(\.\d+)?)$/;
const PERCENT = /^[+-]?(\d+(\.\d+)?|\d{1,3}(,\d{3})+(\.\d+)?)%$/;

/** "=SUM(B2:B9)" is a formula, plain or thousands-separated numbers (and "12%") are numbers, anything else is text. */
export function cellValue(s: string): CellValue {
  const t = s.trim();
  if (t.length > 1 && t.startsWith("=")) return { t: "formula", f: t.slice(1).trim() };
  if (NUMBER.test(t)) return { t: "number", v: Number(t.replace(/,/g, "")) };
  if (PERCENT.test(t)) return { t: "number", v: Number(t.slice(0, -1).replace(/,/g, "")) / 100 };
  return { t: "text", v: s };
}

/** 0 -> A, 25 -> Z, 26 -> AA. */
export function colLetter(i: number): string {
  let s = "";
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}
