// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/adminValidate.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateUsername, validatePassword, validateServerName, validateServerDescription } from '../adminValidate';

test('validateUsername: 3..32 chars after trim', () => {
  assert.equal(validateUsername('ab'), 'admin.err.username');
  assert.equal(validateUsername('  ab  '), 'admin.err.username'); // trimmed to 2
  assert.equal(validateUsername('abc'), null);
  assert.equal(validateUsername('  abc  '), null);
  assert.equal(validateUsername('a'.repeat(32)), null);
  assert.equal(validateUsername('a'.repeat(33)), 'admin.err.username');
  assert.equal(validateUsername(''), 'admin.err.username');
});

test('validatePassword: at least 8 chars, no trimming', () => {
  assert.equal(validatePassword('1234567'), 'admin.err.password');
  assert.equal(validatePassword('12345678'), null);
  assert.equal(validatePassword(' '.repeat(8)), null); // spaces count as characters
  assert.equal(validatePassword(' '.repeat(7)), 'admin.err.password');
});

test('validateServerName: <= 60 chars, no control characters', () => {
  assert.equal(validateServerName(''), null); // 0..60 allowed by the protocol
  assert.equal(validateServerName('a'.repeat(60)), null);
  assert.equal(validateServerName('a'.repeat(61)), 'admin.err.name');
  assert.equal(validateServerName('a\tb'), 'admin.err.name');
  assert.equal(validateServerName('a\nb'), 'admin.err.name');
  assert.equal(validateServerName('a\u007fb'), 'admin.err.name');
  assert.equal(validateServerName('My サーバー'), null);
});

test('validateServerDescription: <= 280 chars', () => {
  assert.equal(validateServerDescription(''), null);
  assert.equal(validateServerDescription('a'.repeat(280)), null);
  assert.equal(validateServerDescription('a'.repeat(281)), 'admin.err.desc');
});
