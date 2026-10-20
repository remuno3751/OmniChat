import { useCallback } from 'react';
import { getDevice, useDevice, type Language } from '../deviceSettings';
import en from './en';
import ja from './ja';

/**
 * Language registry. Adding a language = one file (same keys as en.ts) + one line here.
 * Keys are flat; values may contain `{name}` placeholders.
 */
export const LANGS: Record<string, Record<string, string>> = { en, ja };

export type Vars = Record<string, string | number>;

/** Device setting 'auto' resolves from the OS/browser locale. */
function systemLang(): string {
  let loc = '';
  try {
    loc = (typeof navigator !== 'undefined' && navigator.language) || Intl.DateTimeFormat().resolvedOptions().locale || '';
  } catch {}
  return loc.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

/** The language actually used right now (never 'auto'). */
export function resolveLanguage(setting: Language): string {
  if (setting === 'auto') return systemLang();
  return setting in LANGS ? setting : 'en';
}

function format(s: string, vars?: Vars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** Translates `key` in the given language: that language, then English, then the key itself. */
export function translate(lang: string, key: string, vars?: Vars): string {
  const s = LANGS[lang]?.[key] ?? en[key] ?? key;
  return format(s, vars);
}

/** Translate with the current device language (non-reactive; prefer useT() in components). */
export function t(key: string, vars?: Vars): string {
  return translate(resolveLanguage(getDevice().language), key, vars);
}

/** Returns `t` bound to the current language; the component re-renders when the language changes. */
export function useT(): (key: string, vars?: Vars) => string {
  const setting = useDevice((s) => s.language);
  const lang = resolveLanguage(setting);
  return useCallback((key: string, vars?: Vars) => translate(lang, key, vars), [lang]);
}
