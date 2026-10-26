// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/callLogic.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeDetail, closeErrorOf, closeReasonKey, isTypingTarget, manualReconnectWait, nextReconnectDelay,
  parseCloseDetail, sanitizeReason, shouldAutoReconnect,
} from '../voice/callLogic.ts';
import { RECONNECT_MAX_AUTO, RECONNECT_MIN_MS } from '../voice/voiceApi.ts';
import { parseServerMessage } from '../voice/ariaProtocol.ts';

test('reconnect: the wait is the rest of RECONNECT_MIN_MS since the last attempt', () => {
  assert.equal(RECONNECT_MIN_MS, 3000);
  assert.equal(manualReconnectWait(10000, null), 0);
  assert.equal(manualReconnectWait(10000, 10000), 3000);
  assert.equal(manualReconnectWait(11500, 10000), 1500);
  assert.equal(manualReconnectWait(13000, 10000), 0);
  assert.equal(manualReconnectWait(20000, 10000), 0);
});

test('reconnect: automatic retries stop at RECONNECT_MAX_AUTO', () => {
  assert.equal(RECONNECT_MAX_AUTO, 3);
  assert.equal(nextReconnectDelay(10000, 10000, 0), 3000);
  assert.equal(nextReconnectDelay(10000, 10000, 2), 3000);
  assert.equal(nextReconnectDelay(10000, 10000, 3), null);
  assert.equal(nextReconnectDelay(10000, 10000, 4), null);
  assert.equal(nextReconnectDelay(12000, null, 0), 0);
});

test('shouldAutoReconnect: unexpected closes retry; 4409, 4429 and terminal reasons do not', () => {
  assert.equal(shouldAutoReconnect({}), true);
  assert.equal(shouldAutoReconnect({ code: 1006 }), true);
  assert.equal(shouldAutoReconnect({ reason: 'aria_restarting' }), true);
  assert.equal(shouldAutoReconnect({ reason: 'generic_thing' }), true);
  assert.equal(shouldAutoReconnect({ code: 4409 }), false);
  assert.equal(shouldAutoReconnect({ code: 4429 }), false);
  assert.equal(shouldAutoReconnect({ code: 4429, reason: 'quota' }), false);
  assert.equal(shouldAutoReconnect({ reason: 'voice_off' }), false);
  assert.equal(shouldAutoReconnect({ reason: 'busy' }), false);
  assert.equal(shouldAutoReconnect({ reason: 'quota' }), false);
});

test('closeErrorOf: 4409 is off, 4429 is busy unless the reason says quota', () => {
  assert.equal(closeErrorOf({ code: 4409 }), 'off');
  assert.equal(closeErrorOf({ code: 4429 }), 'busy');
  assert.equal(closeErrorOf({ code: 4429, reason: 'busy' }), 'busy');
  assert.equal(closeErrorOf({ code: 4429, reason: 'quota' }), 'quota');
  assert.equal(closeErrorOf({ code: 1006 }), null);
  assert.equal(closeErrorOf({ reason: 'quota' }), null);
});

test('sanitizeReason: lower case, only a-z 0-9 _ space -, at most 60 characters', () => {
  assert.equal(sanitizeReason('aria_restarting'), 'aria_restarting');
  assert.equal(sanitizeReason('Aria Restarting!'), 'aria restarting');
  assert.equal(sanitizeReason('<script>x</script>'), 'scriptxscript');
  assert.equal(sanitizeReason('a\n\tb"c\'d'), 'abcd');
  assert.equal(sanitizeReason('x'.repeat(100)).length, 60);
  assert.equal(sanitizeReason('!!!'), '');
  assert.equal(sanitizeReason(''), '');
});

test('closeDetail and parseCloseDetail round-trip the code and the reason', () => {
  assert.equal(closeDetail(4409, undefined), 'code:4409');
  assert.equal(closeDetail(4429, 'quota'), 'code:4429;reason:quota');
  assert.equal(closeDetail(1001, 'aria_restarting'), 'reason:aria_restarting');
  assert.equal(closeDetail(1006, ''), undefined);
  assert.equal(closeDetail(undefined, undefined), undefined);
  assert.equal(closeDetail(1000, 'bad<>reason'), 'reason:badreason');

  assert.deepEqual(parseCloseDetail('code:4429;reason:quota'), { code: 4429, reason: 'quota' });
  assert.deepEqual(parseCloseDetail('reason:aria_restarting'), { reason: 'aria_restarting' });
  assert.deepEqual(parseCloseDetail('code:4409'), { code: 4409 });
  assert.deepEqual(parseCloseDetail('code:abc;reason:'), {});
  assert.deepEqual(parseCloseDetail('socket'), {});
  assert.deepEqual(parseCloseDetail(undefined), {});
  // the parsed reason is sanitized again, whatever the detail says
  assert.deepEqual(parseCloseDetail('reason:A<b>'), { reason: 'ab' });
});

test('closeReasonKey: known reasons map to their text, anything else to the generic one', () => {
  assert.equal(closeReasonKey('aria_restarting'), 'host.call.reason.aria_restarting');
  assert.equal(closeReasonKey('voice_off'), 'host.call.reason.voice_off');
  assert.equal(closeReasonKey('busy'), 'host.call.reason.busy');
  assert.equal(closeReasonKey('quota'), 'host.call.reason.quota');
  assert.equal(closeReasonKey('something_else'), 'host.call.reason.generic');
  assert.equal(closeReasonKey('constructor'), 'host.call.reason.generic');
  assert.equal(closeReasonKey(null), 'host.call.reason.generic');
  assert.equal(closeReasonKey(undefined), 'host.call.reason.generic');
});

test('isTypingTarget: text fields keep the space key; buttons and the page do not', () => {
  assert.equal(isTypingTarget(null), false);
  assert.equal(isTypingTarget(undefined), false);
  assert.equal(isTypingTarget({ tagName: 'INPUT' }), true);
  assert.equal(isTypingTarget({ tagName: 'textarea' }), true);
  assert.equal(isTypingTarget({ tagName: 'SELECT' }), true);
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: 'BODY' }), false);
  assert.equal(isTypingTarget({ tagName: 'DIV' }), false);
});

test('parseServerMessage: ready keeps the relay fields (conversationId, private); omni_stats is typed', () => {
  const ready = parseServerMessage('{"type":"ready","codec":"pcm16","sample_rate":16000,"tts_modes":[],"conversationId":"c1","private":true}');
  assert.equal(ready.conversationId, 'c1');
  assert.equal(ready.private, true);
  assert.equal(parseServerMessage('{"type":"ready","codec":"pcm16","sample_rate":16000}').private, undefined);
  assert.deepEqual(parseServerMessage('{"type":"omni_stats","latencyMs":850}'), { type: 'omni_stats', latencyMs: 850 });
});
