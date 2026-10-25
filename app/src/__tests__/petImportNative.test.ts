// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/petImportNative.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PET_MAX_BYTES, bytesToBase64, buildNativePetUpload, decodeUtf8, findPetJson, findSpriteSheet,
  parsePetManifest, prepareNativeStills, sheetMimeOf, spriteSizeFault, stillSizeFault,
} from '../petImportNative';
import { STILL_MAX_BYTES, STILL_STATES, matchStillFiles } from '../petStills';

const tr = (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key);
const bytes = (s) => new TextEncoder().encode(s).buffer;

const goodJson = JSON.stringify({
  id: 'mint', displayName: 'Mint', spriteVersionNumber: 2, spritesheetPath: 'spritesheet.webp', description: 'd',
});

test('parsePetManifest accepts a valid v1 and v2 manifest', () => {
  const v2 = parsePetManifest(goodJson);
  assert.equal(v2.ok, true);
  assert.deepEqual(v2.value, { id: 'mint', displayName: 'Mint', spriteVersionNumber: 2, spritesheetPath: 'spritesheet.webp', description: 'd' });
  const v1 = parsePetManifest(JSON.stringify({ id: 'a', displayName: 'A', spriteVersionNumber: 1, spritesheetPath: 'a.png' }));
  assert.equal(v1.ok, true);
  assert.equal(v1.value.spriteVersionNumber, 1);
});

test('parsePetManifest trims and rejects bad input', () => {
  assert.equal(parsePetManifest('{not json').fault.key, 'pets.errBadJson');
  assert.equal(parsePetManifest('[]').fault.key, 'pets.errManifest');
  assert.equal(parsePetManifest('null').fault.key, 'pets.errManifest');
  const bad = (o) => parsePetManifest(JSON.stringify(o)).fault?.key;
  const base = { id: 'x', displayName: 'X', spriteVersionNumber: 2, spritesheetPath: 's.png' };
  assert.equal(bad({ ...base, id: '   ' }), 'pets.errManifest');
  assert.equal(bad({ ...base, id: 'x'.repeat(101) }), 'pets.errManifest');
  assert.equal(bad({ ...base, displayName: '' }), 'pets.errManifest');
  assert.equal(bad({ ...base, spritesheetPath: '' }), 'pets.errManifest');
  assert.equal(bad({ ...base, spriteVersionNumber: 3 }), 'pets.errManifest');
  assert.equal(bad({ ...base, spriteVersionNumber: '2' }), 'pets.errManifest');
  const ok = parsePetManifest(JSON.stringify({ ...base, id: '  x  ' }));
  assert.equal(ok.value.id, 'x');
});

test('sheetMimeOf uses the MIME type first, then the extension', () => {
  assert.equal(sheetMimeOf('a.bin', 'image/webp'), 'image/webp');
  assert.equal(sheetMimeOf('SHEET.PNG', 'application/octet-stream'), 'image/png');
  assert.equal(sheetMimeOf('sheet.webp'), 'image/webp');
  assert.equal(sheetMimeOf('sheet.gif', 'image/gif'), null);
});

test('size checks: sprite sheet limit and still limit', () => {
  assert.equal(spriteSizeFault(PET_MAX_BYTES), null);
  assert.equal(spriteSizeFault(PET_MAX_BYTES + 1).key, 'pets.errTooBig');
  assert.equal(spriteSizeFault(undefined), null);
  assert.equal(stillSizeFault(STILL_MAX_BYTES), null);
  assert.equal(stillSizeFault(STILL_MAX_BYTES + 1).key, 'pets.native.imageTooBig');
  assert.equal(stillSizeFault(0).key, 'pets.native.imageTooBig');
});

test('findPetJson and findSpriteSheet pick files by name', () => {
  const files = [
    { name: 'Spritesheet.webp', uri: 'a' },
    { name: 'PET.JSON', uri: 'b' },
  ];
  assert.equal(findPetJson(files).uri, 'b');
  assert.equal(findSpriteSheet(files, 'spritesheet.webp').uri, 'a');
  // no name match: the only image is used
  assert.equal(findSpriteSheet([{ name: 'other.png', uri: 'c' }], 'missing.png').uri, 'c');
  // no name match and several images: nothing is guessed
  assert.equal(findSpriteSheet([{ name: 'x.png', uri: '1' }, { name: 'y.png', uri: '2' }], 'z.png'), null);
  assert.equal(findPetJson([{ name: 'pet.txt', uri: 'x' }]), null);
});

test('stills: names map to the six states, case-insensitive, extras are reported', () => {
  const names = ['Idle.PNG', 'thinking.webp', 'working.png', 'tool.png', 'done.png', 'error.png', 'notes.txt'];
  const m = matchStillFiles(names.map((name) => ({ name })));
  assert.deepEqual(Object.keys(m.images).sort(), [...STILL_STATES].sort());
  assert.deepEqual(m.unmatched, ['notes.txt']);
  assert.deepEqual(m.duplicates, []);
  const dup = matchStillFiles([{ name: 'idle.png' }, { name: 'idle.webp' }]);
  assert.deepEqual(dup.duplicates, ['idle']);
});

test('bytesToBase64 matches known encodings and handles large buffers', () => {
  assert.equal(bytesToBase64(bytes('abc')), 'YWJj');
  assert.equal(bytesToBase64(bytes('')), '');
  const big = new Uint8Array(0x8000 * 2 + 5).fill(65).buffer;
  const s = bytesToBase64(big);
  assert.equal(Buffer.from(s, 'base64').length, 0x8000 * 2 + 5);
});

test('decodeUtf8 decodes multi-byte text', () => {
  assert.equal(decodeUtf8(bytes('ペット')), 'ペット');
});

test('buildNativePetUpload reads pet.json and the sheet, and refuses bad picks', async () => {
  const bufs = {
    'file:///cache/pet.json': bytes(goodJson),
    'file:///cache/spritesheet.webp': bytes('WEBPDATA'),
  };
  globalThis.fetch = async (uri) => ({ arrayBuffer: async () => bufs[uri] });
  const files = [
    { name: 'pet.json', uri: 'file:///cache/pet.json' },
    { name: 'spritesheet.webp', uri: 'file:///cache/spritesheet.webp', size: 8 },
  ];
  const body = await buildNativePetUpload(files, tr);
  assert.equal(body.manifest.id, 'mint');
  assert.equal(body.mime, 'image/webp');
  assert.equal(Buffer.from(body.sheetBase64, 'base64').toString(), 'WEBPDATA');

  await assert.rejects(buildNativePetUpload([{ name: 'spritesheet.webp', uri: 'x' }], tr), /pets.errNoJson/);
  await assert.rejects(
    buildNativePetUpload([{ name: 'pet.json', uri: 'file:///cache/pet.json' }, { name: 'a.gif', uri: 'y', mimeType: 'image/gif' }], tr),
    /pets.errNoSheet/,
  );
  await assert.rejects(
    buildNativePetUpload([
      { name: 'pet.json', uri: 'file:///cache/pet.json' },
      { name: 'spritesheet.webp', uri: 'file:///cache/spritesheet.webp', size: PET_MAX_BYTES + 1 },
    ], tr),
    /pets.errTooBig/,
  );
});

test('prepareNativeStills uploads originals and requires idle', async () => {
  globalThis.fetch = async () => ({ arrayBuffer: async () => bytes('IMG') });
  const ok = await prepareNativeStills([{ name: 'idle.png', uri: 'u1' }, { name: 'done.webp', uri: 'u2' }], tr);
  assert.equal(ok.idle.mime, 'image/png');
  assert.equal(ok.done.mime, 'image/webp');
  assert.equal(ok.idle.bytes, 3);
  await assert.rejects(prepareNativeStills([{ name: 'done.png', uri: 'u' }], tr), /pets.create.needIdle/);
  await assert.rejects(
    prepareNativeStills([{ name: 'idle.png', uri: 'u', size: STILL_MAX_BYTES + 1 }], tr),
    /pets.native.imageTooBig/,
  );
});
