// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/officeSync.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { inlineRuns, parseMarkdown, toSlides } from '../docModel';
import { cellValue, colLetter, parseSheets } from '../sheetModel';

// Tests run from app/ (process.cwd()), so the server copies sit at ../server/src.
const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

test('server and app docmodel are byte-identical', () => {
  assert.equal(read('../server/src/docmodel.ts'), read('src/docModel.ts'));
});

test('server and app sheetmodel are byte-identical', () => {
  assert.equal(read('../server/src/sheetmodel.ts'), read('src/sheetModel.ts'));
});

test('toSlides: h1 and h2 each start a slide', () => {
  const slides = toSlides(parseMarkdown('# A\ntext\n## B\n- x'), 'T');
  assert.equal(slides.length, 2);
  assert.equal(slides[0].title, 'A');
  assert.deepEqual(slides[0].blocks, [{ kind: 'para', text: 'text' }]);
  assert.equal(slides[1].title, 'B');
  assert.deepEqual(slides[1].blocks, [{ kind: 'bullet', level: 0, text: 'x' }]);
});

test('toSlides: text before the first heading goes on a slide with the given title', () => {
  const slides = toSlides(parseMarkdown('intro line\n\n## B\nbody'), 'Deck');
  assert.equal(slides[0].title, 'Deck');
  assert.deepEqual(slides[0].blocks, [{ kind: 'para', text: 'intro line' }]);
  assert.equal(slides[1].title, 'B');
});

test('toSlides: h3 and deeper become bold paragraphs', () => {
  const slides = toSlides(parseMarkdown('## S\n### sub\ntext'), 'T');
  assert.deepEqual(slides[0].blocks, [
    { kind: 'para', text: '**sub**' },
    { kind: 'para', text: 'text' },
  ]);
});

test('toSlides: an empty document is one title slide', () => {
  const slides = toSlides(parseMarkdown(''), 'Only');
  assert.deepEqual(slides, [{ title: 'Only', blocks: [] }]);
});

test('toSlides: at most 200 slides', () => {
  const md = Array.from({ length: 250 }, (_, i) => `## s${i}`).join('\n');
  assert.equal(toSlides(parseMarkdown(md), 'T').length, 200);
});

test('inlineRuns: bold, italic and code runs', () => {
  assert.deepEqual(inlineRuns('a **b** `c`'), [
    { text: 'a ' },
    { text: 'b', bold: true },
    { text: ' ' },
    { text: 'c', code: true },
  ]);
});

test('parseSheets: a level-2 heading starts a sheet with its header row', () => {
  const sheets = parseSheets('# Title\n\n## Sales\n| a | b |\n|---|---|\n| 1 | 2 |');
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].name, 'Sales');
  assert.equal(sheets[0].header, true);
  assert.deepEqual(sheets[0].rows, [['a', 'b'], ['1', '2']]);
});

test('parseSheets: tables before the first heading form Sheet1', () => {
  const sheets = parseSheets('| x |\n|---|\n| 1 |');
  assert.equal(sheets[0].name, 'Sheet1');
});

test('parseSheets: sheet names are sanitized, capped and made unique', () => {
  const long = 'N'.repeat(40);
  const sheets = parseSheets(`## a:b/c?\n| x |\n|---|\n| 1 |\n## Data\n| x |\n|---|\n| 1 |\n## data\n| x |\n|---|\n| 1 |\n## ${long}\n| x |\n|---|\n| 1 |`);
  assert.deepEqual(sheets.map((s) => s.name), ['abc', 'Data', 'data 2', 'N'.repeat(31)]);
});

test('parseSheets: an empty header row means no header', () => {
  const sheets = parseSheets('## S\n|  |  |\n|---|---|\n| 1 | 2 |');
  assert.equal(sheets[0].header, false);
  assert.deepEqual(sheets[0].rows, [['1', '2']]);
});

test('cellValue: formulas, numbers, percentages and text', () => {
  assert.deepEqual(cellValue('=SUM(B2:B9)'), { t: 'formula', f: 'SUM(B2:B9)' });
  assert.deepEqual(cellValue('1,234.5'), { t: 'number', v: 1234.5 });
  assert.deepEqual(cellValue('-3'), { t: 'number', v: -3 });
  assert.deepEqual(cellValue('12%'), { t: 'number', v: 0.12 });
  assert.deepEqual(cellValue('abc'), { t: 'text', v: 'abc' });
});

test('colLetter: A, Z, AA, ZZ', () => {
  assert.equal(colLetter(0), 'A');
  assert.equal(colLetter(25), 'Z');
  assert.equal(colLetter(26), 'AA');
  assert.equal(colLetter(701), 'ZZ');
});
