// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/sidebarShell.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PEEK_CLOSE_DELAY_MS,
  initialSidebarState,
  reduceSidebar,
  sidebarHotZoneActive,
  sidebarInLayout,
  sidebarOverlayShown,
} from '../components/sidebarMachine.ts';

/** runs a list of events from `s`, returning the final state and the effects in order */
function run(s, events) {
  const effects = [];
  for (const e of events) {
    const r = reduceSidebar(s, e);
    s = r.state;
    effects.push(r.effect);
  }
  return { s, effects };
}

test('pinned start: sidebar in layout, no hot zone, no overlay', () => {
  const s = initialSidebarState(true);
  assert.equal(sidebarInLayout(s), true);
  assert.equal(sidebarHotZoneActive(s), false);
  assert.equal(sidebarOverlayShown(s), false);
});

test('unpinned start: hidden, hot zone active, no overlay', () => {
  const s = initialSidebarState(false);
  assert.equal(sidebarInLayout(s), false);
  assert.equal(sidebarHotZoneActive(s), true);
  assert.equal(sidebarOverlayShown(s), false);
});

test('unpinned: hot zone enter peeks and schedules a close; panel enter cancels it', () => {
  const r1 = reduceSidebar(initialSidebarState(false), { type: 'hotEnter' });
  assert.equal(r1.state.peek, true);
  assert.equal(r1.effect, 'scheduleHotClose');
  assert.equal(sidebarOverlayShown(r1.state), true);
  assert.equal(sidebarInLayout(r1.state), false);
  const r2 = reduceSidebar(r1.state, { type: 'panelEnter' });
  assert.equal(r2.state.peek, true);
  assert.equal(r2.effect, 'cancelClose');
});

test('unpinned: leaving the panel schedules a close; the timer then hides the peek', () => {
  const { s, effects } = run(initialSidebarState(false), [
    { type: 'hotEnter' },
    { type: 'panelEnter' },
    { type: 'panelLeave' },
  ]);
  assert.deepEqual(effects, ['scheduleHotClose', 'cancelClose', 'scheduleClose']);
  assert.equal(s.peek, true, 'still peeking until the timer fires');
  const closed = reduceSidebar(s, { type: 'closeTimer' });
  assert.equal(closed.state.peek, false);
  assert.equal(closed.effect, null);
  assert.equal(sidebarOverlayShown(closed.state), false);
});

test('returning to the panel within the delay cancels the pending close (no flicker)', () => {
  const { s, effects } = run(initialSidebarState(false), [
    { type: 'hotEnter' },
    { type: 'panelEnter' },
    { type: 'panelLeave' },
    { type: 'panelEnter' },
  ]);
  assert.equal(effects[3], 'cancelClose');
  assert.equal(s.peek, true);
});

test('a close timer that fires after the peek was already cancelled is a no-op', () => {
  const r = reduceSidebar({ pinned: false, open: false, peek: false }, { type: 'closeTimer' });
  assert.equal(r.state.peek, false);
  assert.equal(r.effect, null);
});

test('hot zone enter while the sidebar is already in layout or shown is a no-op', () => {
  const pinned = reduceSidebar(initialSidebarState(true), { type: 'hotEnter' });
  assert.equal(pinned.effect, null);
  assert.equal(pinned.state.peek, false);
  const shown = reduceSidebar({ pinned: false, open: true, peek: false }, { type: 'hotEnter' });
  assert.equal(shown.effect, null);
  assert.equal(shown.state.peek, false);
});

test('panel leave does nothing when there is no peek (pinned or explicitly shown)', () => {
  const pinned = reduceSidebar(initialSidebarState(true), { type: 'panelLeave' });
  assert.equal(pinned.effect, null);
  const shown = reduceSidebar({ pinned: false, open: true, peek: false }, { type: 'panelLeave' });
  assert.equal(shown.effect, null);
  assert.equal(sidebarOverlayShown(shown.state), true, 'an explicit show stays until toggled');
});

test('toggle while pinned hides the layout sidebar; hot zone then peeks it', () => {
  const hidden = reduceSidebar(initialSidebarState(true), { type: 'toggle' });
  assert.equal(sidebarInLayout(hidden.state), false);
  assert.equal(sidebarHotZoneActive(hidden.state), true);
  const peek = reduceSidebar(hidden.state, { type: 'hotEnter' });
  assert.equal(sidebarOverlayShown(peek.state), true);
  const shown = reduceSidebar(hidden.state, { type: 'toggle' });
  assert.equal(sidebarInLayout(shown.state), true);
});

test('toggle while unpinned shows an explicit overlay that stays until toggled again', () => {
  const shown = reduceSidebar(initialSidebarState(false), { type: 'toggle' });
  assert.equal(shown.state.open, true);
  assert.equal(sidebarOverlayShown(shown.state), true);
  assert.equal(sidebarInLayout(shown.state), false);
  const hidden = reduceSidebar(shown.state, { type: 'toggle' });
  assert.equal(sidebarOverlayShown(hidden.state), false);
});

test('pin transitions: pinning shows the layout sidebar; unpinning hides it and cancels any peek', () => {
  const pinned = reduceSidebar(initialSidebarState(false), { type: 'pin', pinned: true });
  assert.deepEqual(pinned.state, { pinned: true, open: true, peek: false });
  assert.equal(sidebarInLayout(pinned.state), true);
  const unpinned = reduceSidebar(pinned.state, { type: 'pin', pinned: false });
  assert.deepEqual(unpinned.state, { pinned: false, open: false, peek: false });
  assert.equal(unpinned.effect, 'cancelClose');
});

test('unpinning while a peek is open closes it at once', () => {
  const peek = reduceSidebar(initialSidebarState(false), { type: 'hotEnter' }).state;
  const r = reduceSidebar(peek, { type: 'pin', pinned: true });
  assert.equal(r.state.peek, false);
  const back = reduceSidebar(r.state, { type: 'pin', pinned: false });
  assert.equal(back.state.peek, false);
  assert.equal(sidebarOverlayShown(back.state), false);
});

test('a pin value equal to the current one changes nothing (settings sync is idempotent)', () => {
  const s = initialSidebarState(true);
  const r = reduceSidebar(s, { type: 'pin', pinned: true });
  assert.equal(r.state, s);
  assert.equal(r.effect, null);
  const hidden = { pinned: true, open: false, peek: false };
  assert.equal(reduceSidebar(hidden, { type: 'pin', pinned: true }).state, hidden);
});

test('the close delay is a short positive number of milliseconds', () => {
  assert.equal(typeof PEEK_CLOSE_DELAY_MS, 'number');
  assert.ok(PEEK_CLOSE_DELAY_MS >= 150 && PEEK_CLOSE_DELAY_MS <= 400);
});
