// @ts-nocheck -- node:test typings are not available in this tsconfig.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPcFs } from '../codePreviewPc';
import { assemblePreview } from '../codePreview';
import type { PcApi } from '../codePreviewPc';

function api(over: Partial<PcApi> & { files?: Record<string, string> } = {}): PcApi {
  const files: Record<string, string> = over.files ?? {
    'index.html': '<link rel="stylesheet" href="css/a.css"><img src="logo.png"><script src="js/a.js"></script>',
    'css/a.css': 'body{color:red}',
    'js/a.js': 'window.x=1',
    'logo.png': 'data:image/png;base64,AAAA',
    'notes.bin': 'x',
  };
  return {
    status: over.status ?? (async () => ({ available: true })),
    tree: over.tree ?? (async (_c, dir) => {
      const prefix = dir ? dir + '/' : '';
      const names = new Map<string, 'file' | 'dir'>();
      for (const p of Object.keys(files)) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const i = rest.indexOf('/');
        names.set(i < 0 ? rest : rest.slice(0, i), i < 0 ? 'file' : 'dir');
      }
      return [...names].map(([name, kind]) => ({ name, kind, size: 10 }));
    }),
    file: over.file ?? (async (_c, p) => files[p]),
  };
}

test('loads text and image files recursively and assembles them', async () => {
  const r = await loadPcFs('c1', api());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual([...r.fs.keys()].sort(), ['css/a.css', 'index.html', 'js/a.js', 'logo.png']);
  const a = assemblePreview(r.fs, { entry: 'index.html', runScripts: true, allowExternal: false });
  assert.ok(a.html.includes('body{color:red}'));
  assert.ok(a.html.includes('data:image/png;base64,AAAA'));
  assert.deepEqual(a.warnings, []);
});

test('unavailable preview reports the reason', async () => {
  const r = await loadPcFs('c1', api({ status: async () => ({ available: false, reason: 'fs_disabled' }) }));
  assert.deepEqual(r, { ok: false, reason: 'fs_disabled' });
});

test('errors fall back instead of throwing', async () => {
  const r = await loadPcFs('c1', api({ file: async () => { throw new Error('boom'); } }));
  assert.deepEqual(r, { ok: false, reason: 'error' });
  const s = await loadPcFs('c1', api({ status: async () => { throw new Error('x'); } }));
  assert.deepEqual(s, { ok: false, reason: 'error' });
});

test('file count is bounded', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 200; i++) files[`f${i}.txt`] = 'x';
  const r = await loadPcFs('c1', api({ files }));
  assert.equal(r.ok, true);
  if (r.ok) assert.ok(r.fs.size <= 80);
});
