// @ts-nocheck -- node:test typings are not available in this tsconfig.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVirtualFs, listPreviewEntries, assemblePreview, normalizePath, toBase64,
} from '../codePreview';
import type { ChangeRun } from '../codePreview';
import type { FileChange } from '../protocol';

const run = (messageId: string, changes: FileChange[]): ChangeRun => ({ messageId, changes });
const ch = (path: string, status: FileChange['status'], patch?: string): FileChange => ({
  path, status, additions: 0, deletions: 0, ...(patch === undefined ? {} : { patch }),
});
const ADD = (text: string) => `--- /dev/null\n+++ b/x\n@@ -0,0 +1,${text.split('\n').length - (text.endsWith('\n') ? 1 : 0)} @@\n${text.replace(/\n$/, '').split('\n').map((l) => `+${l}`).join('\n')}\n`;

test('added: full content with trailing newline', () => {
  const fs = buildVirtualFs([run('m1', [ch('a.html', 'added', '--- /dev/null\n+++ b/a.html\n@@ -0,0 +1,2 @@\n+<p>hi</p>\n+<p>x</p>\n')])]);
  assert.deepEqual(fs.get('a.html'), { content: '<p>hi</p>\n<p>x</p>\n', stale: false });
});

test('added: no newline at end of file', () => {
  const p = '@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file\n';
  const fs = buildVirtualFs([run('m1', [ch('n.txt', 'added', p)])]);
  assert.equal(fs.get('n.txt')?.content, 'a\nb');
  assert.equal(fs.get('n.txt')?.stale, false);
});

test('added: header-less patch takes the + lines', () => {
  const fs = buildVirtualFs([run('m1', [ch('h.txt', 'added', '+++ b/h.txt\n+one\n+two\n')])]);
  assert.equal(fs.get('h.txt')?.content, 'one\ntwo\n');
});

test('modified applies a hunk when the context matches', () => {
  const fs = buildVirtualFs([
    run('m1', [ch('s.css', 'added', ADD('a\nb\nc\n'))]),
    run('m2', [ch('s.css', 'modified', '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n')]),
  ]);
  assert.deepEqual(fs.get('s.css'), { content: 'a\nB\nc\n', stale: false });
});

test('modified with mismatched context is stale and keeps the old content', () => {
  const fs = buildVirtualFs([
    run('m1', [ch('s.css', 'added', ADD('a\nb\nc\n'))]),
    run('m2', [ch('s.css', 'modified', '@@ -1,3 +1,3 @@\n a\n-X\n+B\n c\n')]),
  ]);
  assert.deepEqual(fs.get('s.css'), { content: 'a\nb\nc\n', stale: true });
});

test('modified on an unknown file is stale with empty content', () => {
  const fs = buildVirtualFs([run('m1', [ch('z.css', 'modified', '@@ -1 +1 @@\n-a\n+b\n')])]);
  assert.deepEqual(fs.get('z.css'), { content: '', stale: true });
});

test('deleted removes the file; renamed moves it (arrow form and header form)', () => {
  const fs = buildVirtualFs([
    run('m1', [ch('gone.html', 'added', ADD('x\n')), ch('old.css', 'added', ADD('c{}\n'))]),
    run('m2', [ch('gone.html', 'deleted'), ch('old.css => new.css', 'renamed')]),
    run('m3', [ch('p.css', 'added', ADD('p{}\n')), ch('q.css', 'renamed', 'rename from p.css\nrename to q.css\n')]),
  ]);
  assert.equal(fs.has('gone.html'), false);
  assert.equal(fs.has('old.css'), false);
  assert.equal(fs.get('new.css')?.content, 'c{}\n');
  assert.equal(fs.has('p.css'), false);
  assert.equal(fs.get('q.css')?.content, 'p{}\n');
});

test('paths are normalized: ./ prefix and backslashes', () => {
  assert.equal(normalizePath('./a.css'), 'a.css');
  assert.equal(normalizePath('dir\\b.js'), 'dir/b.js');
  assert.equal(normalizePath('../escape.js'), null);
  const fs = buildVirtualFs([run('m1', [ch('./a.css', 'added', ADD('x\n')), ch('dir\\b.js', 'added', ADD('y\n'))])]);
  assert.ok(fs.has('a.css'));
  assert.ok(fs.has('dir/b.js'));
});

test('toBase64 matches Node for ASCII and multi-byte text', () => {
  for (const s of ['', 'a', 'ab', 'abc', 'あ😀 svg <x/>']) {
    assert.equal(toBase64(s), Buffer.from(s, 'utf8').toString('base64'));
  }
});

const SVG_LOGO = '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n';
const SVG_BG = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>\n';
const INDEX = [
  '<!doctype html><html><head><title>t</title>',
  '<link rel="stylesheet" href="css/style.css">',
  '<script src="js/app.js"></script>',
  '</head><body><img src="img/logo.svg"><img src="missing.png">',
  '<style>.a{background:url(img/bg.svg)}</style></body></html>',
].join('');

function sampleFs() {
  return buildVirtualFs([run('m1', [
    ch('index.html', 'added', ADD(INDEX)),
    ch('css/style.css', 'added', ADD('body{color:red}\n.b{background:url(../img/bg.svg)}\n')),
    ch('js/app.js', 'added', ADD('console.log("</script>")\n')),
    ch('img/logo.svg', 'added', ADD(SVG_LOGO)),
    ch('img/bg.svg', 'added', ADD(SVG_BG)),
  ])]);
}

test('assemblePreview inlines CSS and JS, escapes </script, and converts svg to data URLs', () => {
  const out = assemblePreview(sampleFs(), { entry: 'index.html', runScripts: true, allowExternal: false });
  assert.ok(out.html.includes('<style>body{color:red}'));
  assert.ok(!out.html.includes('href="css/style.css"'));
  assert.ok(out.html.includes('<script>console.log("<\\/script>")\n</script>'));
  assert.ok(out.html.includes(`src="data:image/svg+xml;base64,${Buffer.from(SVG_LOGO).toString('base64')}"`));
  // ../img/bg.svg is resolved from css/ and inlined as a data URL
  assert.ok(out.html.includes(`url("data:image/svg+xml;base64,${Buffer.from(SVG_BG).toString('base64')}")`));
  // the inline <style> in index.html resolves img/bg.svg from the entry directory
  assert.ok(out.html.includes(`url("data:image/svg+xml;base64,${Buffer.from(SVG_BG).toString('base64')}")`));
  assert.ok(out.used.includes('css/style.css') && out.used.includes('js/app.js') && out.used.includes('img/logo.svg'));
});

test('assemblePreview ignores paths that leave the project and warns about unresolved refs', () => {
  const fs = buildVirtualFs([run('m1', [
    ch('index.html', 'added', ADD('<html><head></head><body><script src="../../evil.js"></script><img src="missing.png"></body></html>\n')),
  ])]);
  const out = assemblePreview(fs, { entry: 'index.html', runScripts: true, allowExternal: false });
  assert.ok(out.warnings.some((w) => w.includes('../../evil.js')));
  assert.ok(out.warnings.some((w) => w.includes('missing.png')));
  assert.ok(out.html.includes('src="missing.png"'));
});

test('assemblePreview warns when a used file is stale', () => {
  const fs = buildVirtualFs([run('m1', [
    ch('index.html', 'added', ADD('<link rel="stylesheet" href="s.css"><p>x</p>\n')),
    ch('s.css', 'modified', '@@ -1 +1 @@\n-a\n+b\n'),
  ])]);
  const out = assemblePreview(fs, { entry: 'index.html', runScripts: true, allowExternal: false });
  assert.ok(out.warnings.some((w) => w.includes('s.css')));
});

test('module scripts: import is not run (warned), plain module is inlined', () => {
  const fs = buildVirtualFs([run('m1', [
    ch('index.html', 'added', ADD('<script type="module" src="m.js"></script><script type="module" src="n.js"></script>\n')),
    ch('m.js', 'added', ADD("import x from './y.js';\nx();\n")),
    ch('n.js', 'added', ADD('const k = 1;\n')),
  ])]);
  const out = assemblePreview(fs, { entry: 'index.html', runScripts: true, allowExternal: false });
  assert.ok(out.warnings.some((w) => w.includes('m.js')));
  assert.ok(out.html.includes('<script type="text/plain">'));
  assert.ok(out.html.includes('<script type="module">const k = 1;'));
});

test('CSP meta is the first thing in head; allowExternal changes its content; works without <head>', () => {
  const fs = sampleFs();
  const off = assemblePreview(fs, { entry: 'index.html', runScripts: true, allowExternal: false }).html;
  const on = assemblePreview(fs, { entry: 'index.html', runScripts: true, allowExternal: true }).html;
  const csp = off.indexOf('http-equiv="Content-Security-Policy"');
  assert.ok(csp > 0 && csp < off.indexOf('<title>'));
  assert.ok(off.includes("default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"));
  assert.ok(!off.includes('https:'));
  assert.ok(on.includes("script-src 'unsafe-inline' https:"));
  assert.ok(on.includes('connect-src https:'));

  const bare = buildVirtualFs([run('m1', [ch('p.html', 'added', ADD('<p>hi</p>\n'))])]);
  const out = assemblePreview(bare, { entry: 'p.html', runScripts: true, allowExternal: false }).html;
  assert.ok(out.startsWith('<head><meta http-equiv="Content-Security-Policy"'));
  assert.ok(out.includes('<p>hi</p>'));
});

test('runScripts false removes every script element', () => {
  const out = assemblePreview(sampleFs(), { entry: 'index.html', runScripts: false, allowExternal: false });
  assert.ok(!/<script/i.test(out.html));
  assert.ok(out.html.includes('<style>body{color:red}'));
});

test('listPreviewEntries: index.html first, then the rest in path order', () => {
  const fs = buildVirtualFs([run('m1', [
    ch('b.html', 'added', ADD('x\n')),
    ch('index.html', 'added', ADD('x\n')),
    ch('a/x.htm', 'added', ADD('x\n')),
    ch('c.txt', 'added', ADD('x\n')),
  ])]);
  assert.deepEqual(listPreviewEntries(fs), ['index.html', 'a/x.htm', 'b.html']);
});
