// Charts of an xlsx artifact for the preview (the server writes the real ones: server/src/office-charts.ts).
// A ```chart JSON block belongs to the `##` sheet it sits in; without labels / series it reads that sheet's table.
import { cellValue, type Sheet } from './sheetModel';
import type { ChartSpec } from './components/ChartBlock';

interface Found { start: number; raw: string }

function chartFences(lines: string[]): Found[] {
  const out: Found[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(`{3,}|~{3,})\s*chart\s*$/i.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !/^\s*(`{3,}|~{3,})\s*$/.test(lines[j])) j++;
    out.push({ start: i, raw: lines.slice(i + 1, j).join('\n') });
    i = j;
  }
  return out;
}

/** The preview kind of a chart type: column / bar / area / doughnut are drawn as bar, line, or pie. */
function previewType(t: unknown): ChartSpec['type'] | null {
  switch (String(t ?? 'column').toLowerCase()) {
    case 'column': case 'bar': return 'bar';
    case 'line': case 'area': return 'line';
    case 'pie': case 'doughnut': case 'donut': return 'pie';
    default: return null;
  }
}

function bind(o: any, sh: Sheet): ChartSpec | null {
  const type = previewType(o.type ?? o.kind);
  if (!type) return null;
  const title = typeof o.title === 'string' ? o.title : undefined;
  const labels = o.labels ?? o.categories;
  if (Array.isArray(labels) && Array.isArray(o.series)) {
    const series = o.series.map((s: any, i: number) => ({ name: String(s?.name ?? `Series ${i + 1}`), data: (s?.data ?? s?.values ?? []).map((v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)) }));
    return series.length ? { type, title, labels: labels.map(String), series } : null;
  }
  const start = sh.header ? 1 : 0;
  const data = sh.rows.slice(start).filter((r) => r.some((c) => c !== ''));
  const width = sh.rows[0]?.length ?? 0;
  if (!data.length || width < 2) return null;
  const val = (s: string) => { const v = cellValue(s); return v.t === 'number' ? v.v : 0; };
  const cols: number[] = [];
  for (let c = 1; c < width && cols.length < 8; c++) if (data.every((r) => ['number', 'formula'].includes(cellValue(r[c] ?? '').t))) cols.push(c);
  if (!cols.length) return null;
  return { type, title, labels: data.map((r) => r[0] ?? ''), series: cols.map((c) => ({ name: sh.header ? sh.rows[0][c] : `Series ${c}`, data: data.map((r) => val(r[c] ?? '')) })) };
}

/** Preview charts per sheet position. */
export function sheetCharts(md: string, sheets: Sheet[]): Map<number, ChartSpec[]> {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const secs: { line: number; titled: boolean; table: boolean }[] = [{ line: -1, titled: false, table: false }];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { fence = !fence; continue; }
    if (fence) continue;
    if (/^##(?!#)\s+/.test(lines[i])) secs.push({ line: i, titled: true, table: false });
    else if (lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])) secs[secs.length - 1].table = true;
  }
  const kept = secs.map((s, idx) => ({ ...s, idx })).filter((s) => s.titled || s.table);
  const out = new Map<number, ChartSpec[]>();
  for (const f of chartFences(lines)) {
    let o: any;
    try { o = JSON.parse(f.raw); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    let sec = 0;
    for (let k = 0; k < secs.length; k++) if (secs[k].line < f.start) sec = k;
    const si = kept.findIndex((s) => s.idx === sec);
    if (si < 0 || si >= sheets.length) continue;
    const spec = bind(o, sheets[si]);
    if (spec) out.set(si, [...(out.get(si) ?? []), spec]);
  }
  return out;
}
