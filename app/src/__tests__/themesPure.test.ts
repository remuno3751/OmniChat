// @ts-nocheck -- node:test typings are not available in this tsconfig.
// vscode-ext/scripts/gen-tokens.mjs bundles app/src/themes/{simple,frontier,astral}.ts on their own, so they must stay pure data:
// no import except `import type`, and no function, class or call-with-effects in the file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const NAMES = ['simple', 'frontier', 'astral'];
const src = (n) => fs.readFileSync(new URL(`../themes/${n}.ts`, import.meta.url), 'utf8');
/** drops comments and string literals so the checks look at code only */
const code = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');

for (const n of NAMES) {
  test(`themes/${n}.ts is pure data`, () => {
    const c = code(src(n));
    for (const m of c.matchAll(/^\s*import\b.*$/gm)) assert.match(m[0], /^\s*import\s+type\b/, `${n}: only "import type" is allowed: ${m[0].trim()}`);
    assert.ok(!/^\s*(export\s+)?(default\s+)?(async\s+)?function\b/m.test(c), `${n}: no function declarations`);
    assert.ok(!/=>/.test(c), `${n}: no arrow functions`);
    assert.ok(!/\bclass\b/.test(c), `${n}: no classes`);
    assert.ok(!/\brequire\s*\(|\bimport\s*\(/.test(c), `${n}: no dynamic imports`);
    // a call expression is only allowed as part of a comment-free data literal: none at all
    assert.ok(!/\b[A-Za-z_$][\w$]*\s*\(/.test(c.replace(/^\s*import\s+type.*$/gm, '')), `${n}: no function calls`);
  });
}

test('Astral light diff-add reaches 3:1 against the page background', () => {
  const lum = (hex) => {
    const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const s = src('astral');
  const light = s.slice(s.indexOf('const light'), s.indexOf('export const astral'));
  const bg = /bg: '(#[0-9a-f]{6})'/i.exec(light)[1];
  const add = /diffAdd: '(#[0-9a-f]{6})'/i.exec(light)[1];
  const [hi, lo] = [lum(bg), lum(add)].sort((a, b) => b - a);
  assert.ok((hi + 0.05) / (lo + 0.05) >= 3, `${add} on ${bg}`);
});
