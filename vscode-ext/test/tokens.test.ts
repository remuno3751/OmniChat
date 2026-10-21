import { describe, expect, it } from 'vitest';
import { assertPureData, buildTokensCss, buildTokensJson, paletteToCssVars } from '../scripts/lib/tokens-core.mjs';
// gen-tokens.mjs has no declaration file yet (tsconfig has no allowJs).
// @ts-ignore
import { loadThemes } from '../scripts/gen-tokens.mjs';

const REQUIRED = [
  'bg', 'panel', 'border', 'text', 'sub', 'accent', 'accentText', 'accentInk',
  'danger', 'warn', 'good', 'diffAdd', 'diffDel', 'code', 'codeText', 'input',
  'userBubble', 'botBubble',
].map((k) => `--oc-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);

const IDS = ['simple', 'frontier', 'astral'];
const MODES = ['light', 'dark'];
const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([^)]*\))$/i;

/** Parses the declarations of the block for one theme/mode out of the CSS text. */
function varsOf(css: string, id: string, mode: string): Record<string, string> {
  const selector = `:root[data-oc-theme="${id}"][data-oc-mode="${mode}"] {`;
  const start = css.indexOf(selector);
  expect(start, `missing block ${selector}`).toBeGreaterThanOrEqual(0);
  const body = css.slice(start + selector.length, css.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const m = /^\s*(--[a-z0-9-]+):\s*(.+);$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

describe('tokens', () => {
  it('turns palette keys into kebab-case --oc- variables', () => {
    const vars = paletteToCssVars({ borderStrong: '#111111', diffAdd: '#222222' });
    expect(vars).toEqual({ '--oc-border-strong': '#111111', '--oc-diff-add': '#222222' });
  });

  it('gives every theme x mode the required colour variables', async () => {
    const themes = await loadThemes();
    expect(themes.map((t: { id: string }) => t.id)).toEqual(IDS);
    const css = buildTokensCss(themes);
    for (const id of IDS) {
      for (const mode of MODES) {
        const vars = varsOf(css, id, mode);
        for (const name of REQUIRED) {
          expect(vars, `${id}/${mode} ${name}`).toHaveProperty(name);
          expect(vars[name], `${id}/${mode} ${name}`).toMatch(COLOR);
        }
      }
    }
  });

  it('emits shape, font and motion variables alongside the palette', async () => {
    const themes = await loadThemes();
    const vars = varsOf(buildTokensCss(themes), 'astral', 'dark');
    expect(vars['--oc-r-pill']).toBe('999px');
    expect(vars['--oc-dur-2']).toBe('240ms');
    expect(vars['--oc-ease']).toMatch(/^cubic-bezier\(/);
    expect(vars['--oc-font-body']).toContain('ZenMaruGothic_400Regular');
  });

  it('emits the app type roles (label weights, caps, tracking, line-height boost, mono, Japanese fallback)', async () => {
    const themes = await loadThemes();
    const f = varsOf(buildTokensCss(themes), 'frontier', 'dark');
    expect(f['--oc-label-w']).toBe('500');
    expect(f['--oc-label-wb']).toBe('700');
    expect(f['--oc-label-case']).toBe('uppercase');
    expect(f['--oc-label-tracking']).toBe('1.2px');
    expect(f['--oc-lh-boost']).toBe('0.1');
    expect(f['--oc-font-label']).toBe(f['--oc-font-body']);
    expect(f['--oc-font-mono']).toBe('monospace');
    const a = varsOf(buildTokensCss(themes), 'astral', 'light');
    expect(a['--oc-label-w']).toBe('400');
    expect(a['--oc-label-wb']).toBe('600');
    expect(a['--oc-label-case']).toBe('none');
    expect(a['--oc-label-tracking']).toBe('0.6px');
    expect(a['--oc-font-label']).toContain('Outfit_400Regular');
    expect(a['--oc-font-head']).toBe('"Marcellus_400Regular", "ZenMaruGothic_400Regular", system-ui, sans-serif');
    const s = varsOf(buildTokensCss(themes), 'simple', 'dark');
    expect(s['--oc-font-body']).toBe('system-ui, sans-serif');
    expect(s['--oc-lh-boost']).toBe('0');
  });

  it('ignores sepia and contrast modes', async () => {
    const css = buildTokensCss(await loadThemes());
    expect(css).not.toMatch(/sepia|contrast/);
    const json = buildTokensJson(await loadThemes()) as { themes: Record<string, Record<string, unknown>> };
    for (const id of IDS) expect(Object.keys(json.themes[id])).toEqual(MODES);
  });

  it('rejects a function value in a theme definition', () => {
    expect(() => assertPureData({ id: 'x', modes: { light: { bg: '#fff' } } })).not.toThrow();
    expect(() => assertPureData({ id: 'x', modes: { light: { bg: () => '#fff' } } })).toThrow(/modes\.light\.bg/);
    expect(() => assertPureData({ id: 'x', fn() { return 1; } })).toThrow(/non-data value \(function\)/);
  });

  it('rejects class instances and cycles', () => {
    expect(() => assertPureData({ id: 'x', when: new Date() })).toThrow(/class instance/);
    const cyclic: Record<string, unknown> = { id: 'x' };
    cyclic.self = cyclic;
    expect(() => assertPureData(cyclic)).toThrow(/cyclic/);
  });

  it('produces identical output on every run', async () => {
    const a = await loadThemes();
    const b = await loadThemes();
    expect(buildTokensCss(a)).toBe(buildTokensCss(b));
    expect(JSON.stringify(buildTokensJson(a))).toBe(JSON.stringify(buildTokensJson(b)));
  });
});
