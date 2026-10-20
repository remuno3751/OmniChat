import { useColorScheme, useWindowDimensions, Platform } from 'react-native';
import { useDevice, type CodeScheme } from './deviceSettings';
import { useFontsReady } from './fonts';
import { THEMES, type Palette, type ThemeDef } from './themes';
import { useReducedMotion } from './ui/motion';
import { motionFactors, type MotionFactors } from './ui/motionLevel';

/** Syntax colors for code blocks (chosen by the device's codeScheme). */
export interface HighlightColors {
  keyword: string;
  string: string;
  number: string;
  comment: string;
  fn: string;
  type: string;
}

/** Code block background/text and highlight colors per scheme. */
const codeSchemes: Record<CodeScheme, { code: string; codeText: string; hl: HighlightColors }> = {
  midnight: {
    code: '#0a0a0f', codeText: '#e6e6f0',
    hl: { keyword: '#c792ea', string: '#c3e88d', number: '#f78c6c', comment: '#6b7089', fn: '#82aaff', type: '#ffcb6b' },
  },
  daylight: {
    code: '#f6f8fa', codeText: '#24292f',
    hl: { keyword: '#cf222e', string: '#0a3069', number: '#0550ae', comment: '#6e7781', fn: '#8250df', type: '#953800' },
  },
  solar: {
    code: '#002b36', codeText: '#839496',
    hl: { keyword: '#859900', string: '#2aa198', number: '#d33682', comment: '#586e75', fn: '#268bd2', type: '#b58900' },
  },
  mono: {
    code: '#1a1a1a', codeText: '#d4d4d4',
    hl: { keyword: '#ffffff', string: '#b0b0b0', number: '#9a9a9a', comment: '#6a6a6a', fn: '#e0e0e0', type: '#cccccc' },
  },
};

export type Theme = Palette & { hl: HighlightColors };
export type ResolvedMode = 'light' | 'dark' | 'sepia' | 'contrast';

const cache = new Map<string, Theme>();

/** The palette for a theme + device theme setting (+ OS scheme when 'system'). sepia/contrast exist only in Simple; elsewhere they map to light/dark. */
export function paletteFor(def: ThemeDef, name: string, system: 'light' | 'dark'): { mode: ResolvedMode; palette: Palette } {
  let mode: ResolvedMode = name === 'system' ? system : (name as ResolvedMode);
  if (!def.modes[mode]) mode = mode === 'contrast' ? 'dark' : mode === 'sepia' ? 'light' : system;
  return { mode, palette: def.modes[mode] as Palette };
}

function build(def: ThemeDef, name: string, system: 'light' | 'dark', codeScheme: CodeScheme): { theme: Theme; mode: ResolvedMode } {
  const { mode, palette } = paletteFor(def, name, system);
  const key = `${def.id}|${mode}|${codeScheme}`;
  let theme = cache.get(key);
  if (!theme) {
    const cs = codeSchemes[codeScheme];
    theme = { ...palette, code: cs.code, codeText: cs.codeText, hl: cs.hl };
    cache.set(key, theme);
  }
  return { theme, mode };
}

/** Resolves the device theme settings to a full Theme. 'system' follows the OS light/dark mode. */
export function useTheme(): Theme {
  const id = useDevice((s) => s.themeId);
  const name = useDevice((s) => s.theme);
  const codeScheme = useDevice((s) => s.codeScheme);
  const system = useColorScheme() === 'dark' ? 'dark' : 'light';
  return build(THEMES[id], name, system, codeScheme).theme;
}

/** Radius for a literal design radius `n`, bucketed into the theme's scale (Simple keeps the literal). */
export function radiusOf(def: ThemeDef, n: number): number {
  const R = def.shape.radius;
  if (!R) return n;
  if (n >= 99) return R.pill;
  return n <= 3 ? R.xs : n <= 6 ? R.sm : n <= 9 ? R.md : n <= 12 ? R.lg : R.xl;
}

export interface ThemeRuntime {
  def: ThemeDef;
  mode: ResolvedMode;
  dark: boolean;
  /** decorations & effects on (device toggle; automatic = off on small phones) */
  fx: boolean;
  /** OS reduce-motion or Animation amount = Off */
  reduceMotion: boolean;
  /** resolved Animation amount and its factors (distance / stagger) */
  mo: MotionFactors;
  /** radius token for a literal design radius */
  r: (n: number) => number;
  /** border width tokens */
  bw: number;
  bwStrong: number;
  /** ms, 0 when the OS asks for reduced motion or effects are off */
  dur: { fast: number; base: number; slow: number };
  /** cubic-bezier of the theme's motion */
  ease: [number, number, number, number];
}

/** The full theme definition + resolved runtime flags (shape/decor/motion tokens). `useTheme()` keeps returning the flat palette. */
export function useThemeDef(): ThemeRuntime {
  const id = useDevice((s) => s.themeId);
  const name = useDevice((s) => s.theme);
  const decorations = useDevice((s) => s.decorations);
  const system = useColorScheme() === 'dark' ? 'dark' : 'light';
  const { width, height } = useWindowDimensions();
  const osReduce = useReducedMotion();
  const amount = useDevice((s) => s.motionAmount);
  const mo = motionFactors(amount, osReduce);
  const reduceMotion = !mo.on;
  const def = THEMES[id];
  const { mode } = paletteFor(def, name, system);
  const smallPhone = Platform.OS !== 'web' && Math.min(width, height) < 360;
  const fx = decorations ?? !smallPhone;
  const m = def.motion;
  return {
    def, mode, dark: mode === 'dark' || mode === 'contrast', fx, reduceMotion, mo,
    r: (n) => radiusOf(def, n),
    bw: def.shape.borderWidth.base,
    bwStrong: def.shape.borderWidth.strong,
    // Animation amount (Settings > Appearance) scales the theme's timings; OS reduce-motion / Off make them 0
    dur: { fast: Math.round(m.fast * mo.durK), base: Math.round(m.base * mo.durK), slow: Math.round(m.slow * mo.durK) },
    ease: m.ease,
  };
}

/** Runs once at the app root: lazily registers the active theme's fonts and publishes them to the Text patch. */
export function useThemeFonts(): void {
  const id = useDevice((s) => s.themeId);
  const def = THEMES[id];
  const ready = useFontsReady(def.fonts.pack);
  activeFonts = ready ? def.fonts : null;
}

/** Font faces the Text patch (ui/textPatch.ts) applies to Text without an explicit fontFamily. */
export let activeFonts: ThemeDef['fonts'] | null = null;

/** Device-level text/layout sizing. */
export function useAppearance(): { fontSize: number; messageWidth: number } {
  const fontSize = useDevice((s) => s.fontSize);
  const messageWidth = useDevice((s) => s.messageWidth);
  return { fontSize, messageWidth };
}
