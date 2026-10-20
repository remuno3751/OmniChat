// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/sheetEval.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeGrid } from '../sheetEval';

const v = (rows) => computeGrid(rows).map((r) => r.map((c) => c.display));

test('SUM, AVERAGE, MIN, MAX, COUNT over a range', () => {
  const rows = [['1'], ['2'], ['4'], ['=SUM(A1:A3)'], ['=AVERAGE(A1:A3)'], ['=MIN(A1:A3)'], ['=MAX(A1:A3)'], ['=COUNT(A1:A3)']];
  assert.deepEqual(v(rows).map((r) => r[0]), ['1', '2', '4', '7', '2.333333333', '1', '4', '3']);
});

test('AVERAGE of a plain range', () => {
  assert.equal(v([['2'], ['4'], ['=AVERAGE(A1:A2)']])[2][0], '3');
});

test('ranges span columns and rows', () => {
  assert.equal(v([['1', '2'], ['3', '4'], ['=SUM(A1:B2)']])[2][0], '10');
});

test('text and empty cells inside a range are ignored', () => {
  const rows = [['a'], ['2'], [''], ['=SUM(A1:A3)'], ['=COUNT(A1:A3)'], ['=AVERAGE(A1:A3)']];
  const out = computeGrid(rows);
  assert.equal(out[3][0].display, '2');
  assert.equal(out[4][0].display, '1');
  assert.equal(out[5][0].display, '2');
});

test('AVERAGE with no numbers is #DIV/0!', () => {
  const out = computeGrid([[''], ['=AVERAGE(A1)']]);
  assert.equal(out[1][0].display, '#DIV/0!');
  assert.equal(out[1][0].error, '#DIV/0!');
});

test('precedence of + - * / and parentheses', () => {
  const out = computeGrid([['=1+2*3'], ['=(1+2)*3'], ['=10-4-3'], ['=8/4/2'], ['=2+6/3'], ['=(2+6)/(1+1)']]);
  assert.deepEqual(out.map((r) => r[0].display), ['7', '9', '3', '1', '4', '4']);
});

test('unary minus', () => {
  const out = computeGrid([['5'], ['=-A1'], ['=2*-3'], ['=-(A1+1)'], ['=--A1']]);
  assert.deepEqual(out.map((r) => r[0].display), ['5', '-5', '-6', '-6', '5']);
});

test('references: plain, absolute, and to formula cells', () => {
  const out = computeGrid([['1'], ['=A1*2'], ['=A2+1'], ['=$A$3+$A$1']]);
  assert.deepEqual(out.map((r) => r[0].display), ['1', '2', '3', '4']);
  assert.equal(out[3][0].fx, true);
});

test('empty and out-of-grid references count as 0', () => {
  const out = computeGrid([[''], ['=A1+1'], ['=A99']]);
  assert.equal(out[1][0].display, '1');
  assert.equal(out[2][0].display, '0');
});

test('division by zero is #DIV/0!', () => {
  const out = computeGrid([['4'], ['0'], ['=A1/B1']]);
  assert.equal(out[2][0].display, '#DIV/0!');
  assert.equal(out[2][0].error, '#DIV/0!');
  assert.equal(out[2][0].fx, true);
});

test('errors propagate to dependent cells', () => {
  const out = computeGrid([['=1/0'], ['=A1+1'], ['=SUM(A1:A2)']]);
  assert.equal(out[1][0].display, '#DIV/0!');
  assert.equal(out[2][0].display, '#DIV/0!');
});

test('circular references are #REF! for every cell in the cycle', () => {
  const out = computeGrid([['=A2'], ['=A1'], ['=A2+1'], ['5']]);
  assert.equal(out[0][0].display, '#REF!');
  assert.equal(out[1][0].display, '#REF!');
  assert.equal(out[2][0].error, '#REF!');
  assert.equal(out[3][0].display, '5');
});

test('self reference inside a range is circular', () => {
  const out = computeGrid([['1'], ['=SUM(A1:A2)']]);
  assert.equal(out[1][0].display, '#REF!');
});

test('unsupported functions and operators keep the formula text with fx true', () => {
  const out = computeGrid([['1'], ['=IF(A1>0,1,0)'], ['=ROUND(1.5)'], ['=A1^2'], ['=A1&"x"'], ['=SUM()'], ['=(1+'], ['=2*A2']]);
  assert.equal(out[1][0].display, '=IF(A1>0,1,0)');
  assert.equal(out[2][0].display, '=ROUND(1.5)');
  assert.equal(out[3][0].display, '=A1^2');
  assert.equal(out[4][0].display, '=A1&"x"');
  assert.equal(out[5][0].display, '=SUM()');
  assert.equal(out[6][0].display, '=(1+');
  for (const row of out.slice(1)) {
    assert.equal(row[0].fx, true);
    assert.equal(row[0].error, undefined);
  }
  // a formula that depends on an unsupported one is also unsupported
  assert.equal(out[7][0].display, '=2*A2');
});

test('unsupported function call keeps the formula text', () => {
  const out = computeGrid([['=IF(1,2,3)']]);
  assert.equal(out[0][0].display, '=IF(1,2,3)');
  assert.equal(out[0][0].fx, true);
});

test('0.1 + 0.2 displays as 0.3', () => {
  const out = computeGrid([['=0.1+0.2']]);
  assert.equal(out[0][0].display, '0.3');
  assert.equal(out[0][0].isNumber, true);
});

test('long results are limited to 10 significant digits', () => {
  assert.equal(computeGrid([['=1/3']])[0][0].display, '0.3333333333');
  assert.equal(computeGrid([['=2/3*3']])[0][0].display, '2');
});

test('thousands separators and percent values are numbers', () => {
  const out = computeGrid([['1,234.5'], ['50%'], ['=A1*2'], ['=A2+1'], ['=SUM(A1:A2)']]);
  assert.equal(out[0][0].isNumber, true);
  assert.equal(out[1][0].isNumber, true);
  assert.equal(out[2][0].display, '2469');
  assert.equal(out[3][0].display, '1.5');
  // A2 holds "50%" -> 0.5, so =A2+1 is 1.5 (the B column is empty, so =B1+1 would be 1)
  assert.equal(out[4][0].display, '1235');
});

test('a text reference in arithmetic is #VALUE!', () => {
  const out = computeGrid([['abc'], ['=A1+1']]);
  assert.equal(out[1][0].display, '#VALUE!');
});

test('a bare reference to a text cell shows the text', () => {
  const out = computeGrid([['hello'], ['=A1']]);
  assert.equal(out[1][0].display, 'hello');
  assert.equal(out[1][0].isNumber, false);
});

test('function names are case-insensitive', () => {
  assert.equal(computeGrid([['1'], ['2'], ['=sum(A1:A2)']])[2][0].display, '3');
});

test('plain cells display raw text and report isNumber', () => {
  const out = computeGrid([['Name', '1,234', '=A1']]);
  assert.deepEqual(out[0][0], { display: 'Name', raw: 'Name', isNumber: false, fx: false });
  assert.equal(out[0][1].display, '1,234');
  assert.equal(out[0][1].isNumber, true);
  assert.equal(out[0][1].fx, false);
});

test('ragged rows keep their shape', () => {
  const out = computeGrid([['1', '2', '3'], ['=A1+B1']]);
  assert.equal(out[0].length, 3);
  assert.equal(out[1].length, 1);
  assert.equal(out[1][0].display, '3');
});

test('empty grid', () => {
  assert.deepEqual(computeGrid([]), []);
});
