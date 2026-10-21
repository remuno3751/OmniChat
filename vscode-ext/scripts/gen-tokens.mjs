#!/usr/bin/env node
// Generates media/generated/tokens.css and tokens.json from app/src/themes/*.ts.
// Each theme file is bundled on its own in memory (themes/index.ts is never used),
// evaluated, and checked to be pure data before any output is produced.

import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPureData, buildTokensCss, buildTokensJson } from './lib/tokens-core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const THEMES_DIR = resolve(here, '../../app/src/themes');
const OUT_DIR = resolve(here, '../media/generated');
export const THEME_IDS = ['simple', 'frontier', 'astral'];

/** Bundles one theme file in memory, evaluates it, and returns its exported ThemeDef. */
export async function loadTheme(id) {
  const file = join(THEMES_DIR, `${id}.ts`);
  if (!existsSync(file)) {
    throw new Error(`theme source not found: ${file} (expected app/ next to vscode-ext/)`);
  }
  let code;
  try {
    const result = await build({
      entryPoints: [file],
      bundle: true,
      write: false,
      format: 'cjs',
      platform: 'neutral',
      target: 'es2022',
      logLevel: 'silent',
    });
    code = result.outputFiles[0].text;
  } catch (err) {
    throw new Error(`failed to bundle ${file}: ${err.message}`);
  }
  let exported;
  try {
    const mod = { exports: {} };
    new Function('module', 'exports', code)(mod, mod.exports);
    exported = mod.exports[id];
  } catch (err) {
    throw new Error(`failed to evaluate ${file}: ${err.message}`);
  }
  if (!exported || typeof exported !== 'object') {
    throw new Error(`${file} does not export a theme named "${id}"`);
  }
  if (exported.id !== id) {
    throw new Error(`${file} exports theme id "${exported.id}", expected "${id}"`);
  }
  assertPureData(exported, id);
  return exported;
}

export async function loadThemes() {
  const themes = [];
  for (const id of THEME_IDS) themes.push(await loadTheme(id));
  return themes;
}

async function writeIfChanged(file, text) {
  let current = null;
  try {
    current = await readFile(file, 'utf8');
  } catch {
    // missing file: write it
  }
  if (current !== text) await writeFile(file, text, 'utf8');
}

export async function generate() {
  const themes = await loadThemes();
  return {
    css: buildTokensCss(themes),
    json: JSON.stringify(buildTokensJson(themes), null, 2) + '\n',
  };
}

export async function main() {
  const { css, json } = await generate();
  await mkdir(OUT_DIR, { recursive: true });
  await writeIfChanged(join(OUT_DIR, 'tokens.css'), css);
  await writeIfChanged(join(OUT_DIR, 'tokens.json'), json);
  console.log(`gen-tokens: wrote ${join(OUT_DIR, 'tokens.css')} and tokens.json`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`gen-tokens: ${err.message}`);
    process.exit(1);
  });
}
