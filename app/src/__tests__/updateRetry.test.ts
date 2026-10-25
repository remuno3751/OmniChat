// @ts-nocheck -- node:test typings are not available in this tsconfig.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { canInstallFromHere, isNativeUpdatePlatform, nextUpdatePollMs, UPDATE_POLL_MS, UPDATE_RETRY_AFTER_ERROR_MS } from '../updateTypes';

describe('update status polling', () => {
  test('regular poll is every 6 hours', () => {
    assert.equal(UPDATE_POLL_MS, 6 * 3600_000);
    assert.equal(nextUpdatePollMs(false), 6 * 3600_000);
  });

  test('a failed load or server error retries after 15 minutes', () => {
    assert.equal(UPDATE_RETRY_AFTER_ERROR_MS, 15 * 60_000);
    assert.equal(nextUpdatePollMs(true), 15 * 60_000);
  });
});

describe('native update platforms', () => {
  test('ios and android are native and never offer a self-install', () => {
    assert.equal(isNativeUpdatePlatform('ios'), true);
    assert.equal(isNativeUpdatePlatform('android'), true);
    assert.equal(canInstallFromHere('ios', true), true);
    assert.equal(canInstallFromHere('android', true), true);
  });

  test('web and desktop keep the self-install when the server allows it', () => {
    assert.equal(isNativeUpdatePlatform('web'), false);
    assert.equal(canInstallFromHere('web', true), true);
    assert.equal(canInstallFromHere('web', false), false);
  });
});
