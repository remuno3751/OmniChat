import type { CodeScheme, ThemeId } from '../deviceSettings';

/** Colour tokens of one theme/mode. `code`/`codeText` are overridden by the independently selectable CodeScheme. */
export interface Palette {
  bg: string; panel: string; panel2: string; border: string; borderStrong: string; text: string; sub: string;
  accent: string; accentText: string;
  /** the accent as a TEXT / icon colour on `bg` (differs from `accent` where the fill colour is unreadable as text, e.g. yellow on white) */
  accentInk: string;
  /** secondary accent: fills and thin lines only, never text */
  accent2: string;
  userBubble: string; botBubble: string;
  code: string; codeText: string; danger: string; input: string; warn: string; good: string;
  /** unread / attention dot */
  notify: string;
  /** modal backdrop */
  scrim: string;
  /** diff lines: added / removed */
  diffAdd: string; diffDel: string;
}

/** Radius scale. Literal design radii in components are bucketed into these (see radiusOf). null = keep the literal (Simple). */
export interface RadiusScale { xs: number; sm: number; md: number; lg: number; xl: number; pill: number }

export type PatternId = 'none' | 'hatch' | 'grid' | 'starfield';
export type TabsVariant = 'segment' | 'tag' | 'folder';
export type BubbleVariant = 'round' | 'bar' | 'card';
export type HintVariant = 'plain' | 'tips' | 'speech';
export type PhaseVariant = 'plain' | 'loading' | 'nodes';
/** popups: plain card / square plate with brackets (Frontier) / notebook = dark frame + paper body + tab (Astral) */
export type SheetVariant = 'plain' | 'plate' | 'notebook';
/** notification badge (new places only, so Simple shows none): none / orange square-ish dot (Frontier) / red disc with "!" (Astral) */
export type BadgeVariant = 'none' | 'dot' | 'bang';
/** one-shot entry motion of cards and popups: none / straight wipe + fade (Frontier) / soft rise + fade (Astral) */
export type EnterMotion = 'none' | 'wipe' | 'rise';

export interface FontFace { regular: string; bold: string }

export interface ThemeDef {
  id: ThemeId;
  /** i18n key of the picker label */
  labelKey: string;
  modes: { light: Palette; dark: Palette; sepia?: Palette; contrast?: Palette };
  shape: {
    radius: RadiusScale | null;
    borderWidth: { base: number; strong: number };
    /** corner-bracket decoration (inputs, popups): arm length in px */
    bracket: number | null;
    /** dotted inner border on cards (Astral light) */
    dottedInner: boolean;
  };
  fonts: {
    /** body face applied to every Text without an explicit fontFamily; null = system font */
    body: FontFace | null;
    heading: FontFace | null;
    /** caps labels / numbers */
    label: FontFace | null;
    /** loader id in fonts.ts */
    pack: 'frontier' | 'astral' | null;
    labelCaps: boolean;
    /** letter spacing of caps labels in px */
    labelTracking: number;
    lineHeightBoost: number;
  };
  shadow: { kind: 'none' | 'soft'; radius: number; opacity: number; offsetY: number };
  /** ms; all become 0 under the OS reduce-motion setting. Nothing loops. */
  motion: { fast: number; base: number; slow: number; ease: [number, number, number, number]; enter: EnterMotion; pressScale: number };
  decor: { pattern: PatternId; patternOpacity: number; orbits: boolean; gradientBg: [string, string] | null };
  variants: { tabs: TabsVariant; bubble: BubbleVariant; hint: HintVariant; phase: PhaseVariant; button: 'round' | 'square' | 'pill'; sheet: SheetVariant; badge: BadgeVariant };
  recommendedCodeScheme?: CodeScheme;
}
