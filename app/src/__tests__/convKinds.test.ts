// @ts-nocheck -- node:test typings are not available in this tsconfig.
import test from 'node:test';
import assert from 'node:assert/strict';
import { kindLogos } from '../convKinds';

test('absent kinds (old server) show the chat logo', () => {
  assert.deepEqual(kindLogos(undefined), ['chat']);
  assert.deepEqual(kindLogos(null), ['chat']);
});

test('empty kinds show the chat logo', () => {
  assert.deepEqual(kindLogos([]), ['chat']);
});

test('chat only', () => {
  assert.deepEqual(kindLogos(['chat']), ['chat']);
});

test('voice only', () => {
  assert.deepEqual(kindLogos(['voice']), ['voice']);
});

test('both are shown in fixed order, chat first', () => {
  assert.deepEqual(kindLogos(['voice', 'chat']), ['chat', 'voice']);
  assert.deepEqual(kindLogos(['chat', 'voice']), ['chat', 'voice']);
});

test('garbage falls back to the chat logo and unknown values are ignored', () => {
  assert.deepEqual(kindLogos('voice'), ['chat']);
  assert.deepEqual(kindLogos(42), ['chat']);
  assert.deepEqual(kindLogos(['video']), ['chat']);
  assert.deepEqual(kindLogos(['video', 'voice', null]), ['voice']);
});
