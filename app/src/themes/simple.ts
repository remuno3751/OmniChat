import type { Palette, ThemeDef } from './types';

const extra = { panel2: '', borderStrong: '', accentInk: '', accent2: '', notify: '', scrim: 'rgba(0,0,0,0.45)', diffAdd: '', diffDel: '' };
const fill = (p: Omit<Palette, keyof typeof extra>, e: Partial<typeof extra> = {}): Palette => ({
  ...p,
  panel2: e.panel2 ?? p.panel,
  borderStrong: e.borderStrong ?? p.border,
  accentInk: e.accentInk ?? p.accent,
  accent2: e.accent2 ?? p.accent,
  notify: e.notify ?? p.danger,
  scrim: extra.scrim,
  diffAdd: p.good,
  diffDel: p.danger,
});

const light = fill({
  bg: '#ffffff', panel: '#f4f4f5', border: '#e4e4e7', text: '#18181b', sub: '#71717a',
  accent: '#10a37f', accentText: '#ffffff', userBubble: '#e3f3ee', botBubble: '#f4f4f5',
  code: '#1e1e2e', codeText: '#e6e6f0', danger: '#dc2626', input: '#ffffff', warn: '#b45309', good: '#15803d',
});
const dark = fill({
  bg: '#101012', panel: '#18181b', border: '#2e2e33', text: '#ececf1', sub: '#9a9aa5',
  accent: '#19c37d', accentText: '#04150e', userBubble: '#1d3a31', botBubble: '#1f1f23',
  code: '#0a0a0f', codeText: '#e6e6f0', danger: '#f87171', input: '#1f1f23', warn: '#fbbf24', good: '#4ade80',
});
const sepia = fill({
  bg: '#f4ecd8', panel: '#ebe2c8', border: '#d6c7a6', text: '#433422', sub: '#7a6a50',
  accent: '#8a5a2b', accentText: '#fffaf0', userBubble: '#e6d6b0', botBubble: '#efe6cf',
  code: '#2b2116', codeText: '#f0e6d2', danger: '#b03a2e', input: '#fbf6e9', warn: '#9a6200', good: '#4f7a2a',
});
const contrast = fill({
  bg: '#000000', panel: '#0a0a0a', border: '#ffffff', text: '#ffffff', sub: '#d4d4d4',
  accent: '#ffd400', accentText: '#000000', userBubble: '#1f1f00', botBubble: '#111111',
  code: '#000000', codeText: '#ffffff', danger: '#ff5c5c', input: '#000000', warn: '#ffd400', good: '#5cff8a',
});

/** The original look. Every token reproduces the previously hard-coded values. */
export const simple: ThemeDef = {
  id: 'simple',
  labelKey: 'themeId.simple',
  modes: { light, dark, sepia, contrast },
  shape: { radius: null, borderWidth: { base: 1, strong: 1 }, bracket: null, dottedInner: false },
  fonts: { body: null, heading: null, label: null, pack: null, labelCaps: false, labelTracking: 0, lineHeightBoost: 0 },
  shadow: { kind: 'none', radius: 0, opacity: 0, offsetY: 0 },
  motion: { fast: 120, base: 200, slow: 300, ease: [0.4, 0, 0.2, 1], enter: 'none', pressScale: 1 },
  decor: { pattern: 'none', patternOpacity: 0, orbits: false, gradientBg: null },
  variants: { tabs: 'segment', bubble: 'round', hint: 'plain', phase: 'plain', button: 'round', sheet: 'plain', badge: 'none' },
};
