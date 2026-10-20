// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/artifacts.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ARTIFACT_EXT, lastArtifact, parseArtifactInfo } from '../artifacts';

test('parseArtifactInfo accepts all six types', () => {
  assert.deepEqual(parseArtifactInfo('artifact type=markdown title="Notes"'), { type: 'markdown', title: 'Notes' });
  assert.deepEqual(parseArtifactInfo('artifact type=html title="Page"'), { type: 'html', title: 'Page' });
  assert.deepEqual(parseArtifactInfo('artifact type=docx title="Memo"'), { type: 'docx', title: 'Memo' });
  assert.deepEqual(parseArtifactInfo('artifact type=pptx title="Deck"'), { type: 'pptx', title: 'Deck' });
  assert.deepEqual(parseArtifactInfo('artifact type=xlsx title="Budget"'), { type: 'xlsx', title: 'Budget' });
  assert.deepEqual(parseArtifactInfo('artifact type=email title="Mail"'), { type: 'email', title: 'Mail' });
});

test('parseArtifactInfo is case-insensitive for the type', () => {
  assert.equal(parseArtifactInfo('artifact type=XLSX').type, 'xlsx');
  assert.equal(parseArtifactInfo('artifact type="Email"').type, 'email');
});

test('parseArtifactInfo defaults to markdown for no type or an unknown type', () => {
  assert.equal(parseArtifactInfo('artifact').type, 'markdown');
  assert.equal(parseArtifactInfo('artifact title="X"').type, 'markdown');
  assert.equal(parseArtifactInfo('artifact type=pdf').type, 'markdown');
});

test('parseArtifactInfo reads single-quoted and bare titles', () => {
  assert.equal(parseArtifactInfo("artifact type=docx title='Single'").title, 'Single');
  assert.equal(parseArtifactInfo('artifact type=docx title=Bare').title, 'Bare');
});

test('parseArtifactInfo returns null for other fence info', () => {
  assert.equal(parseArtifactInfo('typescript'), null);
  assert.equal(parseArtifactInfo('artifacts'), null);
  assert.equal(parseArtifactInfo(''), null);
});

test('ARTIFACT_EXT maps new types', () => {
  assert.equal(ARTIFACT_EXT.xlsx, 'xlsx');
  assert.equal(ARTIFACT_EXT.email, 'eml');
  assert.equal(ARTIFACT_EXT.markdown, 'md');
  assert.equal(ARTIFACT_EXT.html, 'html');
  assert.equal(ARTIFACT_EXT.docx, 'docx');
  assert.equal(ARTIFACT_EXT.pptx, 'pptx');
});

test('lastArtifact returns the last complete artifact block', () => {
  const text = [
    'Intro',
    '```artifact type=xlsx title="First"',
    '## S',
    '| a |',
    '```',
    'middle',
    '```artifact type=email title="Second"',
    'Subject: Hi',
    '',
    'Body',
    '```',
    'after',
  ].join('\n');
  assert.deepEqual(lastArtifact(text), {
    type: 'email',
    title: 'Second',
    content: 'Subject: Hi\n\nBody',
  });
});

test('lastArtifact handles tilde fences and longer backtick fences', () => {
  const text = '~~~artifact type=html title="T"\n<p>a ```js</p>\n~~~';
  assert.deepEqual(lastArtifact(text), { type: 'html', title: 'T', content: '<p>a ```js</p>' });
  const text2 = '````artifact type=markdown title="M"\n```\ninner\n```\n````';
  assert.equal(lastArtifact(text2).content, '```\ninner\n```');
});

test('lastArtifact ignores an unclosed block and returns null without artifacts', () => {
  assert.equal(lastArtifact('```artifact type=docx title="Open"\nno close'), null);
  assert.equal(lastArtifact('just text\n```js\nconst a = 1\n```'), null);
});

test('lastArtifact normalises CRLF', () => {
  const r = lastArtifact('```artifact type=xlsx title="C"\r\nA\r\nB\r\n```');
  assert.equal(r.content, 'A\nB');
  assert.equal(r.type, 'xlsx');
});
