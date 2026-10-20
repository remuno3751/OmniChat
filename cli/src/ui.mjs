export function makeStyle(enabled) {
  const wrap = (open, close) => (s) => (enabled ? `\u001b[${open}m${s}\u001b[${close}m` : String(s));
  return {
    enabled,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
  };
}

/** Plain aligned text table. rows: string[][]; right: set of column indexes to right-align. */
export function table(headers, rows, right = new Set()) {
  const all = [headers, ...rows].map((r) => r.map((c) => String(c ?? "")));
  const widths = headers.map((_, i) => Math.max(...all.map((r) => [...r[i]].length)));
  const pad = (s, i) => {
    const gap = " ".repeat(Math.max(0, widths[i] - [...s].length));
    return right.has(i) ? gap + s : s + gap;
  };
  return all.map((r) => r.map(pad).join("  ").trimEnd()).join("\n");
}
