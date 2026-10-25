// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/artifacts.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ARTIFACT_EXT, countPartialSlides, isEmptyArtifact, lastArtifact, parseArtifactInfo } from '../artifacts';

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

test('isEmptyArtifact is true only for blank content', () => {
  assert.equal(isEmptyArtifact(''), true);
  assert.equal(isEmptyArtifact(' \n\t\n'), true);
  assert.equal(isEmptyArtifact('x'), false);
  assert.equal(isEmptyArtifact('\n# T\n'), false);
});

test('countPartialSlides counts # and ## lines, not ### or text', () => {
  const body = ['# Cover', 'sub', '## Slide 2', 'text', '### not a slide', '#tag', '##  Slide 3', '# '].join('\n');
  assert.equal(countPartialSlides(body), 4);
  assert.equal(countPartialSlides(''), 0);
});

test('countPartialSlides ignores lines inside nested code fences', () => {
  const body = [
    '## One',
    '```shapes',
    '# not a slide',
    '## nor this',
    '```',
    '## Two',
    '~~~',
    '## inside tilde',
    '~~~',
    '## Three',
  ].join('\n');
  assert.equal(countPartialSlides(body), 3);
});

test('countPartialSlides keeps counting an unterminated nested fence as open', () => {
  assert.equal(countPartialSlides('## A\n```shapes\n## B\n## C'), 1);
});

test('an artifact opened with three backticks survives inner ```shapes blocks', () => {
  const text = ['intro', '```artifact type=pptx title="Deck"', '## A', '```shapes', 'layout: cover', '```', '## B', '```shapes', 'layout: cards', '```', '```', 'after'].join('\n');
  const a = lastArtifact(text);
  assert.ok(a);
  assert.equal(a!.type, 'pptx');
  assert.match(a!.content, /## B/);
  assert.match(a!.content, /layout: cards/);
  assert.doesNotMatch(a!.content, /after/);
});

test('a fence like ```excel whose first line is the artifact line is read as that artifact', () => {
  const text = ['```excel', 'artifact type=xlsx title="Sales"', '## S', '| a | b |', '|---|---|', '| 1 | 2 |', '```chart', '{"type":"column"}', '```', '```'].join('\n');
  const a = lastArtifact(text);
  assert.ok(a);
  assert.equal(a.type, 'xlsx');
  assert.equal(a.title, 'Sales');
  assert.match(a.content, /```chart/);
  assert.doesNotMatch(a.content, /^artifact/);
});
