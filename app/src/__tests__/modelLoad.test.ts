// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/modelLoad.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHOICE_ORDER, RECOMMENDED, decideConflict, formatBytes, isRememberable, loadedSummary,
  normalizeRemembered, parseConflict, parseProgress,
} from '../modelLoad';
import type { ModelConflictInfo } from '../modelLoad';
import { DEVICE_DEFAULTS, getDevice, setDevice } from '../deviceSettings';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

const conflict: ModelConflictInfo = {
  providerId: 'p1', providerName: 'LM Studio', kind: 'lmstudio', model: 'B',
  loaded: [{ id: 'A', sizeBytes: 4.2 * GB }, { id: 'C' }],
};
const noLoaded: ModelConflictInfo = { ...conflict, loaded: [] };

test('CHOICE_ORDER and RECOMMENDED', () => {
  assert.deepEqual(CHOICE_ORDER, ['unload_then_load', 'use_loaded', 'load_both', 'cancel']);
  assert.equal(RECOMMENDED, 'unload_then_load');
  assert.ok(CHOICE_ORDER.includes(RECOMMENDED));
});

test('normalizeRemembered keeps known values and maps garbage to ask', () => {
  for (const v of ['ask', 'unload_then_load', 'use_loaded', 'load_both']) assert.equal(normalizeRemembered(v), v);
  for (const v of ['cancel', 'LOAD_BOTH', '', 0, null, undefined, {}, [], true, 'ask ']) assert.equal(normalizeRemembered(v), 'ask');
});

test('isRememberable is false only for cancel', () => {
  assert.equal(isRememberable('cancel'), false);
  assert.equal(isRememberable('unload_then_load'), true);
  assert.equal(isRememberable('use_loaded'), true);
  assert.equal(isRememberable('load_both'), true);
});

test('decideConflict: ask when remembered is ask, regardless of conflict', () => {
  assert.deepEqual(decideConflict('ask', conflict), { action: 'ask' });
  assert.deepEqual(decideConflict('ask', null), { action: 'ask' });
  assert.deepEqual(decideConflict('ask', conflict, true), { action: 'ask' });
});

test('decideConflict: null conflict always asks', () => {
  for (const r of ['unload_then_load', 'use_loaded', 'load_both']) {
    assert.deepEqual(decideConflict(r, null), { action: 'ask' });
    assert.deepEqual(decideConflict(r, null, false), { action: 'ask' });
  }
});

test('decideConflict: load error always asks', () => {
  for (const r of ['ask', 'unload_then_load', 'use_loaded', 'load_both']) {
    assert.deepEqual(decideConflict(r, conflict, true), { action: 'ask' });
  }
});

test('decideConflict: remembered policies send with that policy', () => {
  assert.deepEqual(decideConflict('unload_then_load', conflict), { action: 'send', policy: 'unload_then_load' });
  assert.deepEqual(decideConflict('load_both', conflict), { action: 'send', policy: 'load_both' });
});

test('decideConflict: use_loaded sends with the first loaded id', () => {
  assert.deepEqual(decideConflict('use_loaded', conflict), { action: 'send', policy: 'use_loaded', useModel: 'A' });
  const d = decideConflict('use_loaded', noLoaded);
  assert.deepEqual(d, { action: 'send', policy: 'use_loaded' });
  assert.equal('useModel' in d, false);
});

test('formatBytes edge cases', () => {
  assert.equal(formatBytes(undefined), '');
  assert.equal(formatBytes(null), '');
  assert.equal(formatBytes(0), '');
  assert.equal(formatBytes(-5), '');
  assert.equal(formatBytes(NaN), '');
  assert.equal(formatBytes(Infinity), '');
  assert.equal(formatBytes(4.2 * GB), '4.2 GB');
  assert.equal(formatBytes(1 * GB), '1.0 GB');
  assert.equal(formatBytes(512 * MB), '512 MB');
  assert.equal(formatBytes(1500 * 1024), '1 MB');
  assert.equal(formatBytes(900 * 1024), '900 KB');
  assert.equal(formatBytes(10), '1 KB');
  assert.equal(formatBytes(2 * 1024 * GB), '2.0 TB');
});

test('loadedSummary joins ids with sizes when known', () => {
  assert.equal(loadedSummary(conflict), 'A (4.2 GB), C');
  assert.equal(loadedSummary(noLoaded), '');
});

test('parseProgress accepts valid frames and drops non-string unloading entries', () => {
  assert.deepEqual(
    parseProgress({ type: 'model_load', conversationId: 'c', messageId: 'm', providerId: 'p', phase: 'unloading', model: 'B', unloading: ['A', 3, 'C'] }),
    { conversationId: 'c', phase: 'unloading', model: 'B', unloading: ['A', 'C'] },
  );
  assert.deepEqual(parseProgress({ type: 'model_load', conversationId: 'c', phase: 'ready', model: 'B' }),
    { conversationId: 'c', phase: 'ready', model: 'B' });
  assert.equal('unloading' in parseProgress({ type: 'model_load', conversationId: 'c', phase: 'loading', model: 'B' }), false);
});

test('parseProgress rejects invalid frames', () => {
  assert.equal(parseProgress(null), null);
  assert.equal(parseProgress(undefined), null);
  assert.equal(parseProgress('model_load'), null);
  assert.equal(parseProgress({ type: 'delta', conversationId: 'c', phase: 'ready', model: 'B' }), null);
  assert.equal(parseProgress({ type: 'model_load', phase: 'ready', model: 'B' }), null);
  assert.equal(parseProgress({ type: 'model_load', conversationId: '', phase: 'ready', model: 'B' }), null);
  assert.equal(parseProgress({ type: 'model_load', conversationId: 'c', phase: 'done', model: 'B' }), null);
  assert.equal(parseProgress({ type: 'model_load', conversationId: 'c', phase: 'loading' }), null);
  assert.equal(parseProgress({ type: 'model_load', conversationId: 'c', phase: 'loading', model: 7 }), null);
});

test('parseConflict accepts a valid conflict and keeps optional sizes', () => {
  const frame = {
    type: 'error', code: 'model_conflict', message: 'x', conversationId: 'c', messageId: 'm',
    conflict: {
      providerId: 'p1', providerName: 'LM Studio', kind: 'lmstudio', model: 'B', modelSizeBytes: 5 * GB,
      loaded: [{ id: 'A', sizeBytes: 4 * GB, vramBytes: 3 * GB }, { id: 'C' }],
    },
  };
  assert.deepEqual(parseConflict(frame), {
    providerId: 'p1', providerName: 'LM Studio', kind: 'lmstudio', model: 'B', modelSizeBytes: 5 * GB,
    loaded: [{ id: 'A', sizeBytes: 4 * GB, vramBytes: 3 * GB }, { id: 'C' }],
  });
});

test('parseConflict rejects malformed conflicts', () => {
  const base = { providerId: 'p1', providerName: 'n', kind: 'ollama', model: 'B', loaded: [{ id: 'A' }] };
  assert.equal(parseConflict(null), null);
  assert.equal(parseConflict({ type: 'error' }), null);
  assert.equal(parseConflict({ conflict: 'nope' }), null);
  for (const k of ['providerId', 'providerName', 'kind', 'model']) {
    assert.equal(parseConflict({ conflict: { ...base, [k]: 5 } }), null, k);
  }
  assert.equal(parseConflict({ conflict: { ...base, loaded: undefined } }), null);
  assert.equal(parseConflict({ conflict: { ...base, loaded: [{ sizeBytes: 1 }] } }), null);
  assert.equal(parseConflict({ conflict: { ...base, loaded: [null] } }), null);
  assert.equal(parseConflict({ conflict: { ...base, loaded: ['A'] } }), null);
});

test('parseConflict drops non-numeric optional sizes instead of rejecting', () => {
  const c = parseConflict({ conflict: { providerId: 'p', providerName: 'n', kind: 'lmstudio', model: 'B', modelSizeBytes: '5', loaded: [{ id: 'A', sizeBytes: 'big' }] } });
  assert.deepEqual(c, { providerId: 'p', providerName: 'n', kind: 'lmstudio', model: 'B', loaded: [{ id: 'A' }] });
});

test('device setting modelLoadPolicy defaults to ask and normalizes', () => {
  assert.equal(DEVICE_DEFAULTS.modelLoadPolicy, 'ask');
  setDevice({ modelLoadPolicy: 'load_both' });
  assert.equal(getDevice().modelLoadPolicy, 'load_both');
  setDevice({ modelLoadPolicy: 'cancel' as any });
  assert.equal(getDevice().modelLoadPolicy, 'ask');
  setDevice({ modelLoadPolicy: 'use_loaded' });
  assert.equal(getDevice().modelLoadPolicy, 'use_loaded');
  setDevice({ modelLoadPolicy: 'ask' });
});
