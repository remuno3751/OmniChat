// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/artifactBlocks.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseBlocks, splitArtifactBlocks } from '../components/markdownParse';

const lines = (s) => s.split('\n');

test('a closed artifact fence parses as a closed code block (no open flag)', () => {
  const bs = parseBlocks(lines('```artifact type=pptx title="D"\n# A\n```'), true);
  assert.deepEqual(bs, [{ k: 'code', lang: 'artifact', info: 'artifact type=pptx title="D"', body: '# A' }]);
});

test('an artifact fence still open while streaming is a block flagged open, not raw text', () => {
  const bs = parseBlocks(lines('Intro\n```artifact type=pptx title="D"\n## S1\n## S2'), true);
  assert.equal(bs.length, 2);
  assert.equal(bs[0].k, 'p');
  assert.deepEqual(bs[1], { k: 'code', lang: 'artifact', info: 'artifact type=pptx title="D"', body: '## S1\n## S2', open: true });
});

test('an open non-artifact fence while streaming is still raw text', () => {
  const bs = parseBlocks(lines('```shapes\nbg: "#fff"'), true);
  assert.deepEqual(bs, [{ k: 'raw', text: '```shapes\nbg: "#fff"' }]);
});

test('an unclosed artifact fence that is not streaming keeps its body as a code block', () => {
  const bs = parseBlocks(lines('```artifact type=docx title="X"\nbody'), false);
  assert.deepEqual(bs, [{ k: 'code', lang: 'artifact', info: 'artifact type=docx title="X"', body: 'body', open: true }]);
});

test('splitArtifactBlocks moves artifacts after the other blocks, keeping order', () => {
  const text = [
    '```artifact type=docx title="First"', 'a', '```',
    'Before',
    '# Heading',
    '```artifact type=email title="Second"', 'b', '```',
    'After',
  ].join('\n');
  const { body, artifacts } = splitArtifactBlocks(parseBlocks(lines(text), false));
  assert.deepEqual(body.map((b) => b.k), ['p', 'h', 'p']);
  assert.deepEqual(artifacts.map((b) => b.info), ['artifact type=docx title="First"', 'artifact type=email title="Second"']);
});

test('splitArtifactBlocks leaves a message without artifacts unchanged', () => {
  const bs = parseBlocks(lines('# T\n\n```shapes\nbg: x\n```'), false);
  const { body, artifacts } = splitArtifactBlocks(bs);
  assert.deepEqual(body, bs);
  assert.deepEqual(artifacts, []);
});
