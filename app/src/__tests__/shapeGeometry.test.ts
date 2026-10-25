// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/shapeGeometry.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arrowHead, arrowSegment, attachSpecs, boxMap, chartPrimitives, dashArray, formatTick, hasShapesBlock, legendEntries,
  niceTicks, previewKey, shapeOutline, shapeTexts, slideHasShapes, specsInOrder, toUnits, bodyRegion,
  arrowLabelBox, isLightColor,
} from '../shapeGeometry';

// Reference values: server/src/shapes.ts arrowSegment, run on the same boxes (see the boxes below).
const boxes = boxMap([
  { type: 'roundRect', id: 'app', x: 5, y: 40, w: 25, h: 22 },
  { type: 'roundRect', id: 'srv', x: 38, y: 40, w: 25, h: 22 },
  { type: 'cylinder', id: 'db', x: 72, y: 38, w: 22, h: 26 },
  { type: 'rect', id: 'top', x: 40, y: 5, w: 20, h: 10 },
]);

test('arrow between boxes side by side uses the facing sides (same as the server)', () => {
  assert.deepEqual(arrowSegment({ type: 'arrow', from: 'app', to: 'srv' }, boxes), { x1: 30, y1: 51, x2: 38, y2: 51 });
  assert.deepEqual(arrowSegment({ type: 'arrow', from: 'srv', to: 'db' }, boxes), { x1: 63, y1: 51, x2: 72, y2: 51 });
});

test('arrow between a box above and one below uses the vertical sides (same as the server)', () => {
  assert.deepEqual(arrowSegment({ type: 'arrow', from: 'srv', to: 'top' }, boxes), { x1: 50.5, y1: 40, x2: 50, y2: 15 });
  assert.deepEqual(arrowSegment({ type: 'arrow', from: 'top', to: 'srv' }, boxes), { x1: 50, y1: 15, x2: 50.5, y2: 40 });
});

test('arrow by coordinates is taken as is; unknown ids give null', () => {
  assert.deepEqual(arrowSegment({ type: 'arrow', x1: 10, y1: 20, x2: 30, y2: 40 }, boxes), { x1: 10, y1: 20, x2: 30, y2: 40 });
  assert.equal(arrowSegment({ type: 'arrow', from: 'app', to: 'nope' }, boxes), null);
});

test('arrowHead puts the tip at the end and the base back along the line', () => {
  const pts = arrowHead(0, 0, 100, 0, 10, 5);
  assert.deepEqual(pts, [[100, 0], [90, 5], [90, -5]]);
  assert.deepEqual(arrowHead(3, 3, 3, 3, 10, 5), []);
});

test('dashArray scales with the width', () => {
  assert.equal(dashArray('solid', 4), undefined);
  assert.equal(dashArray('dash', 4), '16 12');
  assert.equal(dashArray('dot', 4), '4 10');
});

test('shapeOutline: each box type gives a path; text gives none', () => {
  const box = { x: 0, y: 0, w: 160, h: 90 };
  for (const t of ['rect', 'roundRect', 'ellipse', 'diamond', 'triangle', 'parallelogram', 'hexagon', 'pentagon', 'chevron',
    'rightArrow', 'leftArrow', 'upArrow', 'downArrow', 'cylinder', 'star', 'cloud', 'callout']) {
    const d = shapeOutline(t, box);
    assert.ok(typeof d === 'string' && d.length > 0, t);
    assert.ok(/^M/.test(d), t);
  }
  assert.equal(shapeOutline('text', box), null);
});

test('rect and right arrow paths have the expected corners', () => {
  assert.equal(shapeOutline('rect', { x: 10, y: 20, w: 30, h: 40 }), 'M10 20 L40 20 L40 60 L10 60 Z');
  // right arrow: the tip is at (x + w, y + h / 2)
  assert.match(shapeOutline('rightArrow', { x: 0, y: 0, w: 100, h: 100 }), /L100 50 /);
  assert.match(shapeOutline('upArrow', { x: 0, y: 0, w: 100, h: 100 }), /L50 0 /);
});

test('toUnits maps percent to the 1600 x 900 drawing space', () => {
  assert.deepEqual(toUnits({ x: 50, y: 50, w: 10, h: 20 }), { x: 800, y: 450, w: 160, h: 180 });
});

test('niceTicks covers the range with round steps', () => {
  assert.deepEqual(niceTicks(0, 87), [0, 20, 40, 60, 80, 100]);
  assert.deepEqual(niceTicks(-30, 50, 4), [-40, -20, 0, 20, 40, 60]);
  assert.deepEqual(niceTicks(0, 0), [0, 0.2, 0.4, 0.6, 0.8, 1]);
  assert.deepEqual(niceTicks(5, 5), [5, 5.2, 5.4, 5.6, 5.8, 6]);
  assert.deepEqual(niceTicks(0, 0.3, 3), [0, 0.1, 0.2, 0.3]);
  const t = niceTicks(0, 0.3, 3);
  assert.equal(t[0], 0);
  assert.ok(t[t.length - 1] >= 0.3);
});

test('formatTick keeps integers and rounds the rest', () => {
  assert.equal(formatTick(20), '20');
  assert.equal(formatTick(2.5), '2.5');
  assert.equal(formatTick(1 / 3), '0.33');
});

test('column chart: one bar per value, scaled to the nice maximum', () => {
  const c = { type: 'chart', kind: 'column', categories: ['A', 'B'], series: [{ name: 's', values: [50, 100] }], x: 0, y: 0, w: 100, h: 100 };
  const prims = chartPrimitives(c);
  const bars = prims.filter((p) => p.k === 'rect');
  assert.equal(bars.length, 2);
  // the taller bar is twice the height of the shorter one (0 to 100 scale)
  assert.ok(Math.abs(bars[1].h - bars[0].h * 2) < 1e-6);
  // category labels are text primitives
  assert.ok(prims.some((p) => p.k === 'text' && p.text === 'A'));
});

test('pie chart: slices cover the circle, legend shows the categories with percent', () => {
  const c = { type: 'chart', kind: 'pie', categories: ['x', 'y', 'z'], series: [{ name: 's', values: [1, 1, 2] }], x: 0, y: 0, w: 100, h: 100 };
  const slices = chartPrimitives(c).filter((p) => p.k === 'path');
  assert.equal(slices.length, 3);
  assert.deepEqual(legendEntries(c).map((e) => e.name), ['x 25%', 'y 25%', 'z 50%']);
});

test('chart with no values draws no slices', () => {
  const c = { type: 'chart', kind: 'doughnut', categories: ['x'], series: [{ name: 's', values: [0] }], x: 0, y: 0, w: 100, h: 100 };
  assert.equal(chartPrimitives(c).filter((p) => p.k === 'path').length, 0);
});

test('line chart: one polyline per series; legend only for two or more series', () => {
  const one = { type: 'chart', kind: 'line', categories: ['a', 'b'], series: [{ name: 's', values: [1, 2] }], x: 0, y: 0, w: 50, h: 50 };
  const two = { ...one, series: [{ name: 's', values: [1, 2] }, { name: 't', values: [2, 1] }] };
  assert.equal(legendEntries(one).length, 0);
  assert.equal(legendEntries(two).length, 2);
  assert.equal(chartPrimitives(two).filter((p) => p.k === 'path' && p.fill === 'none').length, 2);
});

test('hasShapesBlock finds a shapes fence only', () => {
  assert.equal(hasShapesBlock('# t\n\n```shapes\nelements: []\n```\n'), true);
  assert.equal(hasShapesBlock('```\nshapes\n```'), false);
  assert.equal(hasShapesBlock('```js\nshapes()\n```'), false);
  assert.equal(hasShapesBlock('plain text'), false);
});

test('previewKey changes with the type, title and content', () => {
  const a = previewKey('pptx', 'T', 'x');
  assert.notEqual(a, previewKey('docx', 'T', 'x'));
  assert.notEqual(a, previewKey('pptx', 'U', 'x'));
  assert.notEqual(a, previewKey('pptx', 'T', 'y'));
  assert.equal(a, previewKey('pptx', 'T', 'x'));
});

test('specsInOrder and attachSpecs pair shapes blocks by order', () => {
  const s1 = { body: 'top', elements: [{ type: 'text', x: 1, y: 1, w: 1, h: 1, text: 'one' }] };
  const s2 = { body: 'none', elements: [{ type: 'text', x: 1, y: 1, w: 1, h: 1, text: 'two' }] };
  const slides = [
    { title: 'a', blocks: [{ kind: 'shapes', raw: 'r1', spec: s1 }] },
    { title: 'b', blocks: [{ kind: 'para', text: 'p' }, { kind: 'shapes', raw: 'r2', spec: s2 }] },
  ];
  assert.deepEqual(specsInOrder(slides), [s1, s2]);
  const blocks = attachSpecs([{ kind: 'shapes', raw: 'r1' }, { kind: 'shapes', raw: 'r2' }, { kind: 'shapes', raw: 'r3' }], [s1, s2]);
  assert.deepEqual(blocks[0], { kind: 'shapes', raw: 'r1', spec: s1 });
  assert.deepEqual(blocks[1], { kind: 'shapes', raw: 'r2', spec: s2 });
  assert.deepEqual(blocks[2], { kind: 'shapes', raw: 'r3' });
});

test('shapeTexts lists box texts, chart titles and arrow labels', () => {
  const spec = {
    body: 'top',
    elements: [
      { type: 'roundRect', id: 'a', x: 0, y: 0, w: 10, h: 10, text: 'A' },
      { type: 'line', x1: 0, y1: 0, x2: 1, y2: 1 },
      { type: 'arrow', from: 'a', to: 'a', label: 'HTTPS' },
      { type: 'chart', kind: 'bar', title: 'Sales', categories: ['x'], series: [{ name: 's', values: [1] }], x: 0, y: 0, w: 10, h: 10 },
    ],
  };
  assert.deepEqual(shapeTexts(spec), ['A', 'HTTPS', 'Sales']);
  assert.equal(slideHasShapes([{ kind: 'shapes', raw: '', spec }]), true);
  assert.equal(slideHasShapes([{ kind: 'shapes', raw: '' }]), false);
});

test('body regions: top, left, right, none', () => {
  assert.ok(bodyRegion('top'));
  assert.equal(bodyRegion('none'), null);
  assert.ok(bodyRegion('left').x < bodyRegion('right').x);
});

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('arrowLabelBox: a horizontal line puts the label above it, centered on the middle', () => {
  const b = arrowLabelBox({ x1: 30, y1: 51, x2: 38, y2: 51 }, 'HTTPS', 12);
  // 5 chars x 12 pt x 0.55 = 33 pt = 3.432 % wide; 12 x 1.5 x 0.185 = 3.33 % high
  near(b.w, 3.432);
  near(b.h, 3.33);
  near(b.x, 34 - 3.432 / 2);
  near(b.y, 51 - (3.33 / 2 + 0.5) - 3.33 / 2);
});

test('arrowLabelBox: a vertical line puts the label to the right of it', () => {
  const b = arrowLabelBox({ x1: 50, y1: 15, x2: 50, y2: 40 }, 'A', 12);
  near(b.w, 0.55 * 12 * 0.104);
  near(b.x, 50 + (b.w / 2 + 0.5) - b.w / 2);
  near(b.y, 27.5 - b.h / 2);
});

test('arrowLabelBox: a CJK character counts as a full em', () => {
  const b = arrowLabelBox({ x1: 10, y1: 50, x2: 20, y2: 50 }, '日本', 12);
  near(b.w, 2 * 12 * 1.0 * 0.104);
});

test('arrowLabelBox: the box stays inside the slide', () => {
  const b = arrowLabelBox({ x1: 98, y1: 50, x2: 100, y2: 50 }, 'ABCDEFGHIJ', 12);
  near(b.x + b.w, 100);
  const top = arrowLabelBox({ x1: 50, y1: 0, x2: 50, y2: 1 }, 'x', 12);
  assert.ok(top.y >= 0 && top.x >= 0);
  const longWide = arrowLabelBox({ x1: 0, y1: 50, x2: 1, y2: 50 }, 'あ'.repeat(40), 12);
  assert.ok(longWide.x >= 0 && longWide.x + longWide.w <= 100 + 1e-9);
});

test('isLightColor: brightness above one half, for #rgb and #rrggbb only', () => {
  assert.equal(isLightColor('#ffffff'), true);
  assert.equal(isLightColor('#fff'), true);
  assert.equal(isLightColor('#1f2937'), false);
  assert.equal(isLightColor('#000'), false);
  assert.equal(isLightColor('white'), false);
  assert.equal(isLightColor(undefined), false);
});
