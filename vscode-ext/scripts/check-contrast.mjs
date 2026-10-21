#!/usr/bin/env node
// WCAG 2.x contrast gate for the generated VS Code webview themes.
// Reads media/generated/tokens.json (produced by gen-tokens.mjs) and checks every
// theme x mode (light, dark) pair that the CSS actually uses as text or as a UI mark.
// Usage: node scripts/check-contrast.mjs   (exit 1 on any unexpected failure)
// Thresholds follow app/scripts/check-contrast.mjs: body text 4.5:1, UI boundaries and
// non-text marks 3:1. Each pair's use is noted in its `why`, taken from base.css/activity.css.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const TOKENS_PATH = join(here, '..', 'media', 'generated', 'tokens.json');
export const MODES = ['light', 'dark'];

// [fg, bg, min, why] — token names without the --oc- prefix.
// Ratios are symmetric, so "text on accent" (button label) and "bg on text" (inverse) need no extra rows.
export const TEXT_PAIRS = [
  ['text', 'bg', 4.5, 'body text'],
  ['text', 'panel', 4.5, 'header, approval, input row'],
  ['text', 'panel2', 4.5, 'button label (.oc-btn)'],
  ['text', 'input', 4.5, 'typed text in .oc-input'],
  ['text', 'user-bubble', 4.5, 'user message body'],
  ['text', 'bot-bubble', 4.5, 'assistant message body'],
  ['sub', 'bg', 4.5, 'secondary text (.oc-msg__role, activity notes)'],
  ['sub', 'panel', 4.5, 'secondary text on panels'],
  ['sub', 'user-bubble', 4.5, 'secondary text in user bubble'],
  ['sub', 'bot-bubble', 4.5, 'secondary text in assistant bubble'],
  ['accent-text', 'accent', 4.5, 'primary button label (.oc-btn--primary)'],
  ['accent-ink', 'bg', 4.5, 'accent text (.oc-chip--run, focus ring)'],
  ['accent-ink', 'panel', 4.5, 'accent text on panels'],
  ['danger', 'bg', 4.5, 'error chip text (.oc-chip--err); also protected badge text'],
  ['danger', 'panel', 4.5, 'error text on panels'],
  ['warn', 'bg', 4.5, 'warning chip text (.oc-chip--wait)'],
  ['warn', 'panel', 4.5, 'warning text on panels'],
  ['good', 'bg', 4.5, 'ok chip text (.oc-chip--ok)'],
  ['good', 'panel', 4.5, 'ok text on panels'],
  ['code-text', 'code', 4.5, 'code preview (.oc-preview)'],
];

// Non-text marks: diff bars and tints, and control boundaries (WCAG 1.4.11).
export const MARK_PAIRS = [
  ['diff-add', 'bg', 3, 'diff add bar and tint (text stays --oc-text)'],
  ['diff-del', 'bg', 3, 'diff delete bar and tint (text stays --oc-text)'],
  ['border-strong', 'bg', 3, 'control and input boundary'],
  ['border-strong', 'panel', 3, 'control and panel boundary'],
];

// Informational only: decorative card borders, not a UI boundary the app relies on.
export const INFO_PAIRS = [['border', 'bg', 3, 'card border (decorative)']];

/**
 * Known real failures in the generated tokens. Each key is `theme/mode/fg/bg`.
 * Reported in the table and returned as `known`, but they do not fail the gate.
 * Do not add entries to hide a new failure: fix the theme or report it.
 */
const LEGACY_SIMPLE = 'legacy Simple palette is pixel-identical by rule (app checker reports it, does not gate it)';
export const KNOWN_FAILURES = {
  // Simple: shipped palette kept unchanged (THEMES-IMPL "pixel-identical" rule).
  'simple/light/sub/panel': LEGACY_SIMPLE,
  'simple/light/sub/user-bubble': LEGACY_SIMPLE,
  'simple/light/sub/bot-bubble': LEGACY_SIMPLE,
  'simple/light/accent-text/accent': LEGACY_SIMPLE,
  'simple/light/accent-ink/bg': LEGACY_SIMPLE,
  'simple/light/accent-ink/panel': LEGACY_SIMPLE,
  'simple/light/danger/panel': LEGACY_SIMPLE,
  'simple/light/border-strong/bg': LEGACY_SIMPLE,
  'simple/light/border-strong/panel': LEGACY_SIMPLE,
  'simple/dark/sub/user-bubble': LEGACY_SIMPLE,
  'simple/dark/border-strong/bg': LEGACY_SIMPLE,
  'simple/dark/border-strong/panel': LEGACY_SIMPLE,
  // Astral light: yellow accent (#e0a92a) diff bar is 1.77:1 on the #eeeadf page; needs a darker add colour in app/src/themes/astral.ts.
};

// ---------- colour math ----------

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNC = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?)\s*)?\)$/i;

/** Parses #rgb, #rgba, #rrggbb, #rrggbbaa and rgb()/rgba() into {r,g,b,a} (0-255, 0-1). */
export function parseColor(input) {
  const s = String(input).trim();
  let m = HEX.exec(s);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  m = FUNC.exec(s);
  if (m) {
    const a = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a };
  }
  throw new Error(`unsupported colour "${s}" (expected #hex or rgb()/rgba())`);
}

/** Composites `fg` over an opaque `bg`, returning an opaque colour. */
export function composite(fg, bg) {
  const a = fg.a;
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
}

/** WCAG 2.x relative luminance of an opaque colour. */
export function luminance({ r, g, b }) {
  const [R, G, B] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/** WCAG contrast ratio between two opaque colours, 1 to 21. */
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ---------- gate ----------

function tokenOf(theme, mode, name, id) {
  const value = theme?.[mode]?.[`--oc-${name}`];
  if (value === undefined) throw new Error(`${id}/${mode}: missing token --oc-${name}`);
  return value;
}

/**
 * Checks every theme x mode in a tokens.json object ({themes:{id:{light,dark}}}).
 * Returns { failures, known, rows, checked }:
 *  - failures: unexpected pairs below their threshold (the gate; empty when passing)
 *  - known: pairs below threshold that are listed in KNOWN_FAILURES
 *  - rows: every gated and informational pair with its ratio, for the table
 *  - checked: number of gated pairs evaluated
 * Each failure/row: { theme, mode, fg, bg, ratio, min, label, status }.
 */
export function checkContrast(tokensJson) {
  const themes = tokensJson?.themes;
  if (!themes || typeof themes !== 'object') throw new Error('tokens.json has no themes object');
  const failures = [];
  const known = [];
  const rows = [];
  let checked = 0;

  const gated = [...TEXT_PAIRS, ...MARK_PAIRS];
  for (const [id, theme] of Object.entries(themes)) {
    for (const mode of MODES) {
      const pageBg = parseColor(tokenOf(theme, mode, 'bg', id));
      if (pageBg.a < 1) throw new Error(`${id}/${mode}: --oc-bg must be opaque`);
      const resolve = (name, base) => composite(parseColor(tokenOf(theme, mode, name, id)), base);

      for (const [pairs, gate] of [[gated, true], [INFO_PAIRS, false]]) {
        for (const [fgName, bgName, min, label] of pairs) {
          const bg = resolve(bgName, pageBg);
          const fg = resolve(fgName, bg);
          const ratio = contrastRatio(fg, bg);
          const key = `${id}/${mode}/${fgName}/${bgName}`;
          const row = { theme: id, mode, fg: fgName, bg: bgName, ratio, min, label };
          if (!gate) {
            rows.push({ ...row, status: 'info' });
            continue;
          }
          checked++;
          if (ratio >= min) {
            rows.push({ ...row, status: 'pass' });
          } else if (KNOWN_FAILURES[key]) {
            known.push(row);
            rows.push({ ...row, status: 'known' });
          } else {
            failures.push(row);
            rows.push({ ...row, status: 'FAIL' });
          }
        }
      }
    }
  }
  return { failures, known, rows, checked };
}

function printTable(rows) {
  const f = (n) => n.toFixed(2).padStart(6);
  console.log('theme     mode   pair                   ratio   min  status  why');
  for (const r of rows) {
    const pair = `${r.fg}/${r.bg}`.padEnd(22);
    console.log(`${r.theme.padEnd(9)} ${r.mode.padEnd(6)} ${pair} ${f(r.ratio)} ${String(r.min).padStart(4)}  ${r.status.padEnd(6)}  ${r.label}`);
  }
}

async function main() {
  const tokens = JSON.parse(readFileSync(TOKENS_PATH, 'utf8'));
  const { failures, known, rows, checked } = checkContrast(tokens);
  printTable(rows);
  console.log('');
  if (known.length) console.log(`${known.length} known failure(s) listed in KNOWN_FAILURES (not gated).`);
  if (failures.length) {
    console.log(`${failures.length} failing pair(s) of ${checked}.`);
    return 1;
  }
  console.log(`contrast OK: ${checked} pairs checked.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
