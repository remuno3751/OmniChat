import type { Palette, ThemeDef } from './types';

// Original palette inspired by industrial signage.
const dark: Palette = {
  bg: '#101113', panel: '#17181a', panel2: '#26272b', border: '#3a3b40', borderStrong: '#7a7c82',
  text: '#f2f2f2', sub: '#a0a2a8',
  accent: '#c8af23', accentText: '#141414', accentInk: '#c8af23', accent2: '#fffa00',
  userBubble: '#222318', botBubble: '#17181a',
  code: '#0a0a0f', codeText: '#e6e6f0', danger: '#ef6a52', input: '#0d0e10', warn: '#f0a030', good: '#c8d655',
  notify: '#ef730b', scrim: 'rgba(8,9,10,0.72)', diffAdd: '#c8d655', diffDel: '#e5624a',
};
const light: Palette = {
  bg: '#fafafa', panel: '#ffffff', panel2: '#e6e6e6', border: '#d9d9d9', borderStrong: '#8a8a8a',
  text: '#191919', sub: '#5e5e5e',
  accent: '#191919', accentText: '#ffffff', accentInk: '#191919', accent2: '#fffa00',
  userBubble: '#f1f1e4', botBubble: '#ffffff',
  code: '#1e1e2e', codeText: '#e6e6f0', danger: '#b83222', input: '#ffffff', warn: '#955000', good: '#3b6200',
  notify: '#d65c00', scrim: 'rgba(25,25,25,0.55)', diffAdd: '#7a9a00', diffDel: '#d0452c',
};

export const frontier: ThemeDef = {
  id: 'frontier',
  labelKey: 'themeId.frontier',
  modes: { light, dark },
  shape: {
    radius: { xs: 0, sm: 0, md: 0, lg: 0, xl: 0, pill: 999 },
    borderWidth: { base: 1, strong: 2 },
    bracket: 7,
    dottedInner: false,
  },
  fonts: {
    body: { regular: 'SpaceGrotesk_400Regular', bold: 'SpaceGrotesk_700Bold' },
    heading: { regular: 'Syncopate_400Regular', bold: 'Syncopate_700Bold' },
    label: { regular: 'SpaceGrotesk_500Medium', bold: 'SpaceGrotesk_700Bold' },
    pack: 'frontier',
    labelCaps: true,
    labelTracking: 1.2,
    lineHeightBoost: 0.1,
  },
  shadow: { kind: 'none', radius: 0, opacity: 0, offsetY: 0 },
  // short, straight, no bounce 
  motion: { fast: 120, base: 160, slow: 220, ease: [0.2, 0, 0, 1], enter: 'wipe', pressScale: 0.97 },
  decor: { pattern: 'hatch', patternOpacity: 0.05, orbits: false, gradientBg: null },
  variants: { tabs: 'tag', bubble: 'bar', hint: 'tips', phase: 'loading', button: 'square', sheet: 'plate', badge: 'dot' },
  recommendedCodeScheme: 'mono',
};
