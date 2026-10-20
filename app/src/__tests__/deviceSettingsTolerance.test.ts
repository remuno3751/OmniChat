// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/deviceSettingsTolerance.test.ts
//
// The stored-JSON loader (load() in deviceSettings.ts) runs once at module import. Each case therefore
// patches AsyncStorage.getItem to return the stored text and imports a fresh module instance
// (cache-busting query). Only public exports are used; deviceSettings.ts is not modified.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import AsyncStorage from '@react-native-async-storage/async-storage';

const realGet = AsyncStorage.getItem;
const realSet = AsyncStorage.setItem;
let caseNo = 0;

/** Imports a fresh deviceSettings module whose stored value (omnichat.device) is `stored`; returns its getDevice(). */
async function loadStored(stored) {
  AsyncStorage.getItem = async (key) => {
    if (key !== 'omnichat.device') return null;
    if (typeof stored === 'function') return stored();
    return stored;
  };
  AsyncStorage.setItem = async () => {};
  caseNo += 1;
  const mod = await import(`../deviceSettings.ts?tolerance=${caseNo}`);
  // load() is async: let its promise chain finish before reading the state
  await new Promise((r) => setTimeout(r, 5));
  return { getDevice: mod.getDevice, defaults: mod.DEVICE_DEFAULTS };
}

after(() => {
  AsyncStorage.getItem = realGet;
  AsyncStorage.setItem = realSet;
});

test('empty object stored -> all defaults', async () => {
  const { getDevice, defaults } = await loadStored('{}');
  assert.deepEqual(getDevice(), defaults);
});

test('JSON null, corrupt JSON, and a storage read error -> all defaults', async () => {
  assert.deepEqual((await loadStored('null')).getDevice(), (await loadStored(undefined)).defaults);
  assert.deepEqual((await loadStored('{not json')).getDevice(), (await loadStored(undefined)).defaults);
  const { getDevice, defaults } = await loadStored(() => {
    throw new Error('storage unavailable');
  });
  assert.deepEqual(getDevice(), defaults);
});

test('unknown extra keys are ignored and not carried into the state', async () => {
  const { getDevice } = await loadStored(JSON.stringify({ language: 'ja', foo: 1, bar: { deep: true } }));
  const d = getDevice();
  assert.equal(d.language, 'ja');
  assert.equal('foo' in d, false);
  assert.equal('bar' in d, false);
});

test('missing keys fall back to the defaults', async () => {
  const { getDevice, defaults } = await loadStored(JSON.stringify({ language: 'en' }));
  const d = getDevice();
  assert.equal(d.language, 'en');
  assert.equal(d.theme, defaults.theme);
  assert.equal(d.fontSize, defaults.fontSize);
  assert.deepEqual(d.dsh, defaults.dsh);
  assert.deepEqual(d.pets, defaults.pets);
});

test('wrong types fall back to the defaults', async () => {
  const { getDevice, defaults } = await loadStored(
    JSON.stringify({
      language: 'fr',
      theme: 42,
      themeId: null,
      decorations: 'yes',
      fontSize: 'big',
      messageWidth: [],
      modelLogosOnline: 'no',
      motionAmount: {},
      streamAnim: 3,
      particleColor: 'red',
      particleColorMode: true,
      ephemeralBannerSeen: 'true',
      modelLoadPolicy: 'nonsense',
    }),
  );
  const d = getDevice();
  assert.equal(d.language, defaults.language);
  assert.equal(d.theme, defaults.theme);
  assert.equal(d.themeId, defaults.themeId);
  assert.equal(d.decorations, null);
  assert.equal(d.fontSize, defaults.fontSize);
  assert.equal(d.messageWidth, defaults.messageWidth);
  assert.equal(d.modelLogosOnline, defaults.modelLogosOnline);
  assert.equal(d.motionAmount, defaults.motionAmount);
  assert.equal(d.streamAnim, defaults.streamAnim);
  assert.equal(d.particleColor, defaults.particleColor);
  assert.equal(d.particleColorMode, defaults.particleColorMode);
  assert.equal(d.ephemeralBannerSeen, defaults.ephemeralBannerSeen);
  assert.equal(d.modelLoadPolicy, defaults.modelLoadPolicy);
});

test('numbers out of range are clamped, not reset', async () => {
  const { getDevice } = await loadStored(JSON.stringify({ fontSize: 99, messageWidth: 10 }));
  assert.equal(getDevice().fontSize, 24);
  assert.equal(getDevice().messageWidth, 560);
});

test('nested pets partial object: known fields kept, the rest default', async () => {
  const { getDevice, defaults } = await loadStored(
    JSON.stringify({ pets: { size: 300, enabled: 'yes', petId: 'cat', activity: 'frantic' } }),
  );
  assert.deepEqual(getDevice().pets, {
    enabled: defaults.pets.enabled,
    petId: 'cat',
    size: 256,
    activity: defaults.pets.activity,
    clickThrough: defaults.pets.clickThrough,
  });
});

test('nested dsh partial object: known fields kept, the rest default', async () => {
  const { getDevice } = await loadStored(JSON.stringify({ dsh: { enabled: true, port: 'x', pairing: 7 } }));
  assert.deepEqual(getDevice().dsh, { enabled: true, port: 19401, pairing: '', bridgeName: 'my-pc' });
});

test('nested objects of the wrong type (null, array, string) fall back to defaults', async () => {
  const cases = [
    { pets: null, dsh: null },
    { pets: [1, 2], dsh: [] },
    { pets: 'pets', dsh: 'dsh' },
  ];
  for (const raw of cases) {
    const { getDevice, defaults } = await loadStored(JSON.stringify(raw));
    const d = getDevice();
    assert.deepEqual(d.pets, defaults.pets, JSON.stringify(raw));
    assert.deepEqual(d.dsh, defaults.dsh, JSON.stringify(raw));
  }
});

test('a stored theme id that no longer exists (renamed or removed) falls back to the default', async () => {
  for (const old of ['endfield', 'hsr', 'zzz', 'Frontier']) {
    const { getDevice, defaults } = await loadStored(JSON.stringify({ themeId: old }));
    assert.equal(getDevice().themeId, defaults.themeId, old);
  }
  const ok = await loadStored(JSON.stringify({ themeId: 'frontier' }));
  assert.equal(ok.getDevice().themeId, 'frontier');
  const ok2 = await loadStored(JSON.stringify({ themeId: 'astral' }));
  assert.equal(ok2.getDevice().themeId, 'astral');
});

test('sidebarPinned: only a real boolean is kept; anything else (missing, string, null) defaults to true', async () => {
  assert.equal((await loadStored('{}')).getDevice().sidebarPinned, true);
  assert.equal((await loadStored(JSON.stringify({ sidebarPinned: false }))).getDevice().sidebarPinned, false);
  assert.equal((await loadStored(JSON.stringify({ sidebarPinned: 'false' }))).getDevice().sidebarPinned, true);
  assert.equal((await loadStored(JSON.stringify({ sidebarPinned: null }))).getDevice().sidebarPinned, true);
});

test('the default theme is frontier', async () => {
  const { defaults } = await loadStored(JSON.stringify({}));
  assert.equal(defaults.themeId, 'frontier');
});
