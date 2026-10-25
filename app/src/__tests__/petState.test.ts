// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/petState.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PET_ROW_FOR_MODE } from '../petState.ts';

test('thinking uses the waiting sprite row', () => {
  assert.equal(PET_ROW_FOR_MODE.thinking, PET_ROW_FOR_MODE.waiting);
  assert.equal(PET_ROW_FOR_MODE.idle, 0);
});
