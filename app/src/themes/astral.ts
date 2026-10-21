import type { Palette, ThemeDef } from './types';

// Original palette inspired by a night-sky / gold-trim look.
const dark: Palette = {
  bg: '#202635', panel: '#2e2c2e', panel2: '#3b3b3b', border: '#524c46', borderStrong: '#d7c493',
  text: '#ffffff', sub: '#c4bdb5',
  accent: '#f9c837', accentText: '#2a2827', accentInk: '#fbe9b6', accent2: '#f4a747',
  userBubble: '#534645', botBubble: '#2e2c2e',
  code: '#0a0a0f', codeText: '#e6e6f0', danger: '#ff7a82', input: '#262426', warn: '#f4a747', good: '#9ad08a',
  notify: '#f3303b', scrim: 'rgba(12,14,28,0.7)', diffAdd: '#f9c837', diffDel: '#f3303b',
};
const light: Palette = {
  bg: '#eeeadf', panel: '#f8f5ee', panel2: '#e9e9e8', border: '#e6d4b7', borderStrong: '#8a7545',
  text: '#2a2827', sub: '#6b5d4c',
  accent: '#f9c837', accentText: '#2a2827', accentInk: '#7a5a00', accent2: '#e6a14c',
  userBubble: '#f3e6c4', botBubble: '#f8f5ee',
  code: '#1e1e2e', codeText: '#e6e6f0', danger: '#b3212b', input: '#fffdf8', warn: '#8a5200', good: '#2f6b2a',
  notify: '#f3303b', scrim: 'rgba(42,40,39,0.5)', diffAdd: '#8f6a00', diffDel: '#d9303a',
};

export const astral: ThemeDef = {
  id: 'astral',
  labelKey: 'themeId.astral',
  modes: { light, dark },
  shape: {
    radius: { xs: 4, sm: 8, md: 10, lg: 12, xl: 22, pill: 999 },
    borderWidth: { base: 1, strong: 1 },
    bracket: null,
    dottedInner: true,
  },
  fonts: {
    body: { regular: 'ZenMaruGothic_400Regular', bold: 'ZenMaruGothic_700Bold' },
    heading: { regular: 'Marcellus_400Regular', bold: 'Marcellus_400Regular' },
    label: { regular: 'Outfit_400Regular', bold: 'Outfit_600SemiBold' },
    pack: 'astral',
    labelCaps: false,
    labelTracking: 0.6,
    lineHeightBoost: 0.08,
  },
  shadow: { kind: 'soft', radius: 22, opacity: 0.28, offsetY: 8 },
  // gentle fades and rises 
  motion: { fast: 180, base: 240, slow: 280, ease: [0.16, 1, 0.3, 1], enter: 'rise', pressScale: 0.96 },
  decor: { pattern: 'starfield', patternOpacity: 0.5, orbits: true, gradientBg: ['#202635', '#2a2f55'] },
  variants: { tabs: 'folder', bubble: 'card', hint: 'speech', phase: 'nodes', button: 'pill', sheet: 'notebook', badge: 'bang' },
};
