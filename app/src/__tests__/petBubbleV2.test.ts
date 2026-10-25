// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/petBubbleV2.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemTitle, unreadBubbleText } from '../petBubble.ts';

test('unread bubble texts in both languages', () => {
  assert.equal(unreadBubbleText('done', 'en'), 'Done. Please check the answer');
  assert.equal(unreadBubbleText('done', 'ja'), '完了しました。回答を確認してください');
  assert.equal(unreadBubbleText('error', 'en'), 'Something went wrong. Please check');
  assert.equal(unreadBubbleText('error', 'ja'), 'エラーが起きました。確認してください');
});

test('item title is trimmed, with a placeholder when empty', () => {
  assert.equal(itemTitle('  Plan a trip ', 'en'), 'Plan a trip');
  assert.equal(itemTitle('   ', 'en'), 'Untitled chat');
  assert.equal(itemTitle('', 'ja'), '無題のチャット');
});
