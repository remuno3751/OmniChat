// Type declarations for tokens-core.mjs (the tsconfig has no allowJs).

export const MODES: readonly ['light', 'dark'];

export function kebab(key: string): string;

export function assertPureData(def: unknown, path?: string, ancestors?: Set<object>): void;

export function paletteToCssVars(palette: Record<string, unknown>, prefix?: string): Record<string, string>;

export function shapeToCssVars(shape: unknown, prefix?: string): Record<string, string>;

export function fontVars(fonts: unknown, prefix?: string): Record<string, string>;

export function motionVars(motion: unknown, prefix?: string): Record<string, string>;

export function modeVars(theme: unknown, mode: 'light' | 'dark'): Record<string, string>;

export function buildTokensCss(themes: unknown[]): string;

export function buildTokensJson(themes: unknown[]): { themes: Record<string, Record<string, Record<string, string>>> };
