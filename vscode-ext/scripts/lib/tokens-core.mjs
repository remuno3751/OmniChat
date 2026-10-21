// Pure token generation (no I/O). Turns app theme data into CSS custom properties
// and a JSON map. Consumed by scripts/gen-tokens.mjs and test/tokens.test.ts.

export const MODES = ['light', 'dark'];
const RADIUS_KEYS = ['xs', 'sm', 'md', 'lg', 'xl', 'pill'];
const SYSTEM_STACK = 'system-ui, sans-serif';
const FACE_NAME = /^[A-Za-z0-9_ -]+$/;
const THEME_ID = /^[a-z]+$/;

/** `borderStrong` -> `border-strong`, `diffAdd` -> `diff-add`. */
export function kebab(key) {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/** Throws unless `def` is plain data: string, finite number, boolean, null, array, or plain object. */
export function assertPureData(def, path = 'theme', ancestors = new Set()) {
  const t = typeof def;
  if (def === null || t === 'string' || t === 'boolean') return;
  if (t === 'number') {
    if (!Number.isFinite(def)) throw new Error(`tokens: ${path} is a non-finite number`);
    return;
  }
  if (t !== 'object') throw new Error(`tokens: ${path} is a non-data value (${t}); theme files must stay pure data`);
  if (ancestors.has(def)) throw new Error(`tokens: ${path} is a cyclic reference`);
  const proto = Object.getPrototypeOf(def);
  if (!Array.isArray(def) && proto !== Object.prototype && proto !== null) {
    throw new Error(`tokens: ${path} is a class instance, not plain data`);
  }
  ancestors.add(def);
  if (Array.isArray(def)) def.forEach((v, i) => assertPureData(v, `${path}[${i}]`, ancestors));
  else for (const k of Object.keys(def)) assertPureData(def[k], `${path}.${k}`, ancestors);
  ancestors.delete(def);
}

/** A CSS value must not be able to break out of its declaration. */
function cssValue(value, where) {
  if (typeof value !== 'string' || value === '' || /[;{}<>]/.test(value)) {
    throw new Error(`tokens: ${where} is not a safe CSS value: ${JSON.stringify(value)}`);
  }
  return value;
}

export function paletteToCssVars(palette, prefix = '--oc-') {
  const out = {};
  for (const [key, value] of Object.entries(palette)) {
    out[`${prefix}${kebab(key)}`] = cssValue(value, `palette.${key}`);
  }
  return out;
}

export function shapeToCssVars(shape, prefix = '--oc-') {
  const out = {};
  if (shape.radius) {
    for (const k of RADIUS_KEYS) out[`${prefix}r-${k}`] = `${shape.radius[k]}px`;
  }
  out[`${prefix}bw-base`] = `${shape.borderWidth.base}px`;
  out[`${prefix}bw-strong`] = `${shape.borderWidth.strong}px`;
  out[`${prefix}bracket`] = `${shape.bracket ?? 0}px`;
  return out;
}

function familyStack(face, where) {
  if (!face) return SYSTEM_STACK;
  if (!FACE_NAME.test(face.regular)) throw new Error(`tokens: ${where} has an unsafe font name`);
  return `"${face.regular}", ${SYSTEM_STACK}`;
}

/** The app's code font on web (`Platform.select({ default: 'monospace' })` in the app's code views). */
const MONO_STACK = 'monospace';

/** `SpaceGrotesk_500Medium` -> { base: 'SpaceGrotesk', weight: 500 }. */
function faceParts(name) {
  const m = /^(.*)_(\d{3})/.exec(name);
  return m ? { base: m[1], weight: Number(m[2]) } : { base: name, weight: 400 };
}

/** Font stack with the body face behind it, like the app's web `stack()` (Japanese falls back to the body face). */
function stackWithBody(face, body, where) {
  if (!face) return SYSTEM_STACK;
  if (!FACE_NAME.test(face.regular)) throw new Error(`tokens: ${where} has an unsafe font name`);
  const first = `"${face.regular}"`;
  if (!body || body.regular === face.regular) return `${first}, ${SYSTEM_STACK}`;
  return `${first}, "${body.regular}", ${SYSTEM_STACK}`;
}

/**
 * Type roles of a theme, as the app resolves them (app/src/ui/skin.tsx useFaces):
 * body / heading / label families, the label weights (regular and bold), caps + tracking, line-height boost.
 * A label face of the same family as the body (Frontier: Space Grotesk 500/700) reuses the body family at its weight;
 * a different label family (Astral: Outfit 400/600) gets its own stack. Bold is a real face (the page uses `font-synthesis: none`).
 */
export function fontVars(fonts, prefix = '--oc-') {
  const body = fonts.body;
  const label = fonts.label;
  const sameFamily = !!(label && body && faceParts(label.regular).base === faceParts(body.regular).base);
  const labelFamily = !label
    ? familyStack(body, 'fonts.body')
    : sameFamily
      ? familyStack(body, 'fonts.body')
      : stackWithBody(label, body, 'fonts.label');
  const lw = label ? faceParts(label.regular).weight : 400;
  const lwb = label ? faceParts(label.bold).weight : 700;
  return {
    [`${prefix}font-body`]: familyStack(body, 'fonts.body'),
    [`${prefix}font-head`]: stackWithBody(fonts.heading, body, 'fonts.heading'),
    [`${prefix}font-label`]: labelFamily,
    [`${prefix}font-mono`]: MONO_STACK,
    [`${prefix}label-w`]: String(label ? lw : 500),
    [`${prefix}label-wb`]: String(label ? lwb : 700),
    [`${prefix}label-case`]: fonts.labelCaps ? 'uppercase' : 'none',
    [`${prefix}label-tracking`]: `${Number(fonts.labelTracking) || 0}px`,
    [`${prefix}lh-boost`]: String(Number(fonts.lineHeightBoost) || 0),
  };
}

export function motionVars(motion, prefix = '--oc-') {
  const [a, b, c, d] = motion.ease;
  return {
    [`${prefix}dur-1`]: `${motion.fast}ms`,
    [`${prefix}dur-2`]: `${motion.base}ms`,
    [`${prefix}dur-3`]: `${motion.slow}ms`,
    [`${prefix}ease`]: `cubic-bezier(${[a, b, c, d].join(', ')})`,
  };
}

/** All custom properties of one theme in one mode (palette + shape + fonts + motion). */
export function modeVars(theme, mode) {
  assertPureData(theme);
  if (!THEME_ID.test(theme.id)) throw new Error(`tokens: theme id "${theme.id}" is not a lowercase word`);
  const palette = theme.modes[mode];
  if (!palette) throw new Error(`tokens: theme "${theme.id}" has no "${mode}" mode`);
  return {
    ...paletteToCssVars(palette),
    ...shapeToCssVars(theme.shape),
    ...fontVars(theme.fonts),
    ...motionVars(theme.motion),
  };
}

function renderBlock(selector, vars) {
  const lines = Object.entries(vars).map(([k, v]) => `  ${k}: ${v};`);
  return `${selector} {\n${lines.join('\n')}\n}\n`;
}

/** CSS for every theme x {light, dark}. sepia/contrast modes are intentionally ignored. */
export function buildTokensCss(themes) {
  if (!Array.isArray(themes)) throw new Error('tokens: buildTokensCss expects an array of themes');
  const blocks = [];
  for (const theme of themes) {
    for (const mode of MODES) {
      const selector = `:root[data-oc-theme="${theme.id}"][data-oc-mode="${mode}"]`;
      blocks.push(renderBlock(selector, modeVars(theme, mode)));
    }
  }
  const header = '/* Generated by vscode-ext/scripts/gen-tokens.mjs from app/src/themes. Do not edit. */\n';
  return header + blocks.join('\n');
}

/** Nested map: { themes: { <id>: { light: {--oc-…}, dark: {--oc-…} } } }. */
export function buildTokensJson(themes) {
  if (!Array.isArray(themes)) throw new Error('tokens: buildTokensJson expects an array of themes');
  const out = { themes: {} };
  for (const theme of themes) {
    out.themes[theme.id] = {};
    for (const mode of MODES) out.themes[theme.id][mode] = modeVars(theme, mode);
  }
  return out;
}
