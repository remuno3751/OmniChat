// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/markdownParseLinear.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks, parseInline } from '../components/markdownParse';

test('unmatched openers stay linear', () => {
  for (const unit of ['*a ', '` ', '_a ', '~~a ', '**a ']) {
    const t0 = Date.now();
    parseInline(unit.repeat(60000));
    assert.ok(Date.now() - t0 < 2000, `slow for ${JSON.stringify(unit)}`);
  }
});

test('emphasis and code still parse', () => {
  assert.deepEqual(parseInline('a *b* `c` **d**'), [
    'a ', { type: 'italic', children: ['b'] }, ' ', { type: 'code', text: 'c' }, ' ', { type: 'bold', children: ['d'] },
  ]);
  assert.ok(parseBlocks(['hello *x'], false).length > 0);
});
