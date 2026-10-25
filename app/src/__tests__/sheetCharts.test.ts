// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/sheetCharts.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSheets } from '../sheetModel';
import { sheetCharts } from '../sheetCharts';

const MD = [
  '## Sales', '| Item | Jan | Feb |', '|---|---|---|', '| A | 10 | 20 |', '| B | 5 | 15 |', '',
  '```chart', '{"type":"column","title":"By item"}', '```', '',
  '## Plain', '| x | y |', '|---|---|', '| 1 | 2 |', '',
  '```chart', '{"type":"pie","labels":["a","b"],"series":[{"name":"s","data":[1,2]}]}', '```',
].join('\n');

test('a chart without data reads the table of its sheet', () => {
  const m = sheetCharts(MD, parseSheets(MD));
  const c = m.get(0)![0];
  assert.equal(c.type, 'bar');
  assert.equal(c.title, 'By item');
  assert.deepEqual(c.labels, ['A', 'B']);
  assert.deepEqual(c.series.map((s) => [s.name, s.data]), [['Jan', [10, 5]], ['Feb', [20, 15]]]);
});

test('a chart with its own data goes to the sheet it sits in', () => {
  const m = sheetCharts(MD, parseSheets(MD));
  assert.equal(m.get(1)![0].type, 'pie');
  assert.equal(m.get(1)!.length, 1);
});

test('bad JSON and charts without a usable table are ignored', () => {
  const md = '## S\n| a | b |\n|---|---|\n| x | y |\n\n```chart\nnope\n```\n\n```chart\n{"type":"line"}\n```\n';
  assert.equal(sheetCharts(md, parseSheets(md)).size, 0);
});
