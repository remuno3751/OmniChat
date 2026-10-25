// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/petBubble.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bubbleFor, bubbleTtl, clipToolName, TOOL_NAME_MAX } from '../petBubble.ts';

test('idle shows no bubble', () => {
  assert.equal(bubbleFor('idle', '', 'ja'), null);
  assert.equal(bubbleFor('idle', '', 'en'), null);
});

test('Japanese texts', () => {
  assert.deepEqual(bubbleFor('thinking', '', 'ja'), { text: '考え中…', ttlMs: null });
  assert.deepEqual(bubbleFor('running', '', 'ja'), { text: '回答を作成中…', ttlMs: null });
  assert.deepEqual(bubbleFor('running', 'web_search', 'ja'), { text: 'web_search を実行中…', ttlMs: null });
  assert.deepEqual(bubbleFor('waiting', '', 'ja'), { text: '承認を待っています', ttlMs: null });
  assert.deepEqual(bubbleFor('jumping', '', 'ja'), { text: 'できました!', ttlMs: 4000 });
  assert.deepEqual(bubbleFor('failed', '', 'ja'), { text: 'エラーが起きました', ttlMs: 6000 });
});

test('English texts', () => {
  assert.equal(bubbleFor('thinking', '', 'en').text, 'Thinking…');
  assert.equal(bubbleFor('running', '', 'en').text, 'Writing the answer…');
  assert.equal(bubbleFor('running', 'read_file', 'en').text, 'Running read_file…');
  assert.equal(bubbleFor('waiting', '', 'en').text, 'Waiting for approval');
  assert.deepEqual(bubbleFor('waving', '', 'en'), { text: 'Done!', ttlMs: 4000 });
  assert.deepEqual(bubbleFor('failed', '', 'en'), { text: 'Something went wrong', ttlMs: 6000 });
});

test('searching uses the tool name when there is one', () => {
  assert.equal(bubbleFor('searching', '', 'en').text, 'Searching…');
  assert.equal(bubbleFor('searching', 'web_search', 'ja').text, 'web_search を実行中…');
});

test('tool names are clipped to 24 characters with an ellipsis', () => {
  const long = 'a'.repeat(40);
  const clipped = clipToolName(long);
  assert.equal(clipped.length, TOOL_NAME_MAX);
  assert.ok(clipped.endsWith('…'));
  assert.equal(clipToolName('short'), 'short');
  assert.equal(clipToolName('a'.repeat(TOOL_NAME_MAX)).length, TOOL_NAME_MAX);
  assert.equal(clipToolName('a'.repeat(TOOL_NAME_MAX)).endsWith('…'), false);
});

test('bubbleTtl matches bubbleFor', () => {
  for (const m of ['idle', 'thinking', 'running', 'searching', 'waiting', 'failed', 'jumping', 'waving']) {
    assert.equal(bubbleTtl(m), bubbleFor(m, '', 'en')?.ttlMs ?? null, m);
  }
});

test('unknown language falls back to English', () => {
  assert.equal(bubbleFor('thinking', '', 'fr').text, 'Thinking…');
});
