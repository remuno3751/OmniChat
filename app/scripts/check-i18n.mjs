// Dev check: fails when src/i18n/en.ts and ja.ts define different keys (or duplicate keys).
import fs from 'node:fs';

const read = (n) => fs.readFileSync(new URL(`../src/i18n/${n}.ts`, import.meta.url), 'utf8');

function keys(src) {
  const ks = [];
  const dup = [];
  for (const m of src.matchAll(/^\s*(?:'((?:[^'\\]|\\.)+)'|"((?:[^"\\]|\\.)+)"):/gm)) {
    const k = m[1] ?? m[2];
    if (ks.includes(k)) dup.push(k);
    ks.push(k);
  }
  return { ks, dup };
}

const en = keys(read('en'));
const ja = keys(read('ja'));
const enSet = new Set(en.ks);
const jaSet = new Set(ja.ks);
let bad = false;
const rep = (label, a) => {
  if (a.length) {
    bad = true;
    console.error(`${label} (${a.length}):\n  ` + a.join('\n  '));
  }
};
rep('keys in en.ts missing from ja.ts', en.ks.filter((k) => !jaSet.has(k)));
rep('keys in ja.ts missing from en.ts', ja.ks.filter((k) => !enSet.has(k)));
rep('duplicate keys in en.ts', en.dup);
rep('duplicate keys in ja.ts', ja.dup);
if (bad) process.exit(1);
console.log(`i18n OK: ${en.ks.length} keys in both en.ts and ja.ts`);
