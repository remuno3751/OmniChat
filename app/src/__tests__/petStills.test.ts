// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/petStills.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STILL_MAX_BYTES, buildPetPrompt, cleanPetName, makeStillsPetId, matchStillFiles, petStateKey,
  stillBytesOk, stillExportSize, stillInputOk, stillSelectionProblem, stillStateOf,
} from '../petStills.ts';

test('petStateKey maps every pet mode to a stills state', () => {
  assert.equal(petStateKey('idle'), 'idle');
  assert.equal(petStateKey('thinking'), 'thinking');
  assert.equal(petStateKey('running'), 'working');
  assert.equal(petStateKey('searching'), 'tool');
  assert.equal(petStateKey('waiting'), 'thinking');
  assert.equal(petStateKey('failed'), 'error');
  assert.equal(petStateKey('jumping'), 'done');
  assert.equal(petStateKey('waving'), 'done');
});

test('stillStateOf reads the state from the file name (case-insensitive, png or webp only)', () => {
  assert.equal(stillStateOf('idle.png'), 'idle');
  assert.equal(stillStateOf('Thinking.WEBP'), 'thinking');
  assert.equal(stillStateOf(' tool .png'), 'tool');
  assert.equal(stillStateOf('C:\\pics\\error.png'), 'error');
  assert.equal(stillStateOf('idle.jpg'), null);
  assert.equal(stillStateOf('idle'), null);
  assert.equal(stillStateOf('idle-2.png'), null);
  assert.equal(stillStateOf('pet.json'), null);
});

test('matchStillFiles assigns files and reports unmatched names and duplicates', () => {
  const files = [{ name: 'idle.png' }, { name: 'done.webp' }, { name: 'notes.txt' }, { name: 'Done.png' }, { name: 'done.png' }];
  const m = matchStillFiles(files);
  assert.equal(m.images.idle, files[0]);
  assert.equal(m.images.done, files[1]);
  assert.deepEqual(m.unmatched, ['notes.txt']);
  assert.deepEqual(m.duplicates, ['done']);
});

test('stillSelectionProblem: too many files, unknown names, duplicates, then missing idle', () => {
  assert.deepEqual(stillSelectionProblem(['idle.png']), null);
  assert.deepEqual(stillSelectionProblem(['idle.png', 'thinking.png', 'working.png', 'tool.png', 'done.png', 'error.png']), null);
  assert.deepEqual(stillSelectionProblem(['thinking.png']), { key: 'pets.create.needIdle' });
  assert.deepEqual(stillSelectionProblem(['idle.png', 'a.png']), { key: 'pets.create.unmatched', names: 'a.png' });
  assert.deepEqual(stillSelectionProblem(['idle.png', 'idle.webp']), { key: 'pets.create.duplicate', names: 'idle' });
  assert.deepEqual(stillSelectionProblem(['idle.png', 'thinking.png', 'working.png', 'tool.png', 'done.png', 'error.png', 'idle2.png']), { key: 'pets.create.tooMany' });
});

test('size and dimension checks', () => {
  assert.equal(STILL_MAX_BYTES, 600 * 1024);
  assert.equal(stillBytesOk(600 * 1024), true);
  assert.equal(stillBytesOk(600 * 1024 + 1), false);
  assert.equal(stillBytesOk(0), false);
  assert.equal(stillInputOk(15, 4000), false);
  assert.equal(stillInputOk(16, 16), true);
});

test('export size keeps the aspect ratio, caps the longest side at 512 and never upscales', () => {
  assert.deepEqual(stillExportSize(1024, 512), { w: 512, h: 256 });
  assert.deepEqual(stillExportSize(300, 200), { w: 300, h: 200 });
  assert.deepEqual(stillExportSize(2000, 1000), { w: 512, h: 256 });
  assert.deepEqual(stillExportSize(20, 17), { w: 20, h: 17 });
});

test('cleanPetName trims and limits to 60 characters; empty gives null', () => {
  assert.equal(cleanPetName('  Mochi  '), 'Mochi');
  assert.equal(cleanPetName('   '), null);
  assert.equal(cleanPetName('x'.repeat(80)).length, 60);
});

test('makeStillsPetId: ascii slug plus suffix, falls back to "pet" for non-ascii names', () => {
  const rand = () => 'abc123';
  assert.equal(makeStillsPetId('My Pet!', rand), 'my-pet-abc123');
  assert.equal(makeStillsPetId('ねこ', rand), 'pet-abc123');
  assert.match(makeStillsPetId('Cat'), /^cat-[a-z0-9]+$/);
  assert.ok(makeStillsPetId('a'.repeat(100), rand).length <= 50);
});

test('buildPetPrompt includes the six file names and the format rules in both languages', () => {
  for (const lang of ['en', 'ja']) {
    const text = buildPetPrompt(lang);
    for (const f of ['idle.png', 'thinking.png', 'working.png', 'tool.png', 'done.png', 'error.png']) {
      assert.ok(text.includes(f), `${lang} ${f}`);
    }
    assert.ok(text.includes('512'), lang);
    assert.ok(text.includes('10%'), lang);
  }
  assert.notEqual(buildPetPrompt('ja'), buildPetPrompt('en'));
});
