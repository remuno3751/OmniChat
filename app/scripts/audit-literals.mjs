// Dev helper: lists hard-coded English user-visible literals per file (heuristic, not exhaustive).
// Usage: node scripts/audit-literals.mjs [path-filter]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../src', import.meta.url));
const filter = process.argv[2] || '';
const out = [];
const propRe = /\b(placeholder|label|title|accessibilityLabel|hint|message|text)=(?:"([^"]*[A-Za-z]{3}[^"]*)"|\{'([^']*[A-Za-z]{3}[^']*)'\})/g;
const fnRe = /\b(toast|confirmDialog|setErr|setError|setMsg|Alert\.alert)\(\s*(?:`([^`]*)`|'([^']*)')/g;
const textRe = />\s*([A-Z][A-Za-z][^<>{}\n]{2,})\s*</g;
const objRe = /\b(label|title|hint|text|name):\s*'([A-Z][^']*[a-z]{2}[^']*)'/g;

function scan(f) {
  const rel = path.relative(root, f).split(path.sep).join('/');
  if (filter && !rel.includes(filter)) return;
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  const hits = [];
  lines.forEach((l, i) => {
    if (/^\s*(import|\/\/|\*|\/\*)/.test(l)) return;
    for (const re of [propRe, fnRe, textRe, objRe]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(l))) hits.push(`${i + 1}: ${(m[2] || m[3] || m[1]).trim()}`);
    }
  });
  if (hits.length) out.push(`## ${rel} (${hits.length})\n` + hits.join('\n'));
}
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'i18n') walk(p); } else if (/\.tsx?$/.test(e.name)) scan(p);
  }
}
walk(root);
console.log(out.join('\n\n'));
