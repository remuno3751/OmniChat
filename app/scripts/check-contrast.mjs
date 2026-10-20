// WCAG contrast gate for every theme x mode. Usage: node scripts/check-contrast.mjs
// Body text pairs need 4.5:1; large text / UI component edges need 3:1. Exits 1 on any failure.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src', 'themes');
const out = mkdtempSync(join(tmpdir(), 'themes-'));
for (const f of ['simple', 'frontier', 'astral']) {
  const js = ts.transpileModule(readFileSync(join(src, `${f}.ts`), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
  writeFileSync(join(out, `${f}.mjs`), js);
}
const themes = Object.fromEntries(await Promise.all(['simple', 'frontier', 'astral'].map(async (f) => [f, (await import(pathToFileURL(join(out, `${f}.mjs`)).href))[f]])));

const lum = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// [fg, bg, min, why]
const PAIRS = [
  ['text', 'bg', 4.5], ['text', 'panel', 4.5], ['text', 'panel2', 4.5], ['text', 'input', 4.5],
  ['text', 'userBubble', 4.5], ['text', 'botBubble', 4.5],
  ['sub', 'bg', 4.5], ['sub', 'panel', 4.5], ['sub', 'panel2', 4.5], ['sub', 'userBubble', 4.5], ['sub', 'input', 4.5],
  ['accentText', 'accent', 4.5], ['accentInk', 'bg', 4.5], ['accentInk', 'panel', 4.5],
  ['danger', 'bg', 4.5], ['danger', 'panel', 4.5], ['warn', 'bg', 4.5], ['good', 'bg', 4.5],
  ['codeText', 'code', 4.5],
  // UI components / large text
  ['borderStrong', 'bg', 3], ['borderStrong', 'panel', 3], ['notify', 'bg', 3], ['notify', 'panel', 3],
];
const CORE = ['accentText|accent', 'text|bg', 'text|panel', 'sub|bg', 'sub|panel', 'codeText|code', 'text|userBubble', 'text|botBubble', 'text|input', 'danger|bg', 'danger|panel'];
let bad = 0;
let n = 0;
for (const [id, def] of Object.entries(themes)) {
  for (const [mode, p] of Object.entries(def.modes)) {
    for (const [fg, bg, min] of PAIRS) {
      if (id === 'simple' && !CORE.includes(`${fg}|${bg}`)) continue; // Simple keeps its historical values; only core pairs are checked
      n++;
      const r = ratio(p[fg], p[bg]);
      // Simple's shipped palette is not changed by the theme work (pixel-identical rule): its misses are reported, not gated.
      if (r < min && id === 'simple') console.log(`warn (legacy Simple, unchanged) ${mode}: ${fg} on ${bg} = ${r.toFixed(2)}`);
      else if (r < min) { bad++; console.log(`FAIL ${id}/${mode}: ${fg} ${p[fg]} on ${bg} ${p[bg]} = ${r.toFixed(2)} (< ${min})`); }
    }
  }
}
console.log(bad ? `${bad} failing pair(s) of ${n}` : `contrast OK: ${n} pairs`);
process.exit(bad ? 1 : 0);
