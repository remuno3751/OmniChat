#!/usr/bin/env node
// Renders media/src/icon.svg to media/icon.png (128x128) with headless Chrome.
// Usage: node scripts/render-icon.mjs [path-to-chrome]. Not part of the normal build.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const chrome = process.argv[2] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SIZE = 128;
const svg = readFileSync(resolve(here, '../media/src/icon.svg'), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'oc-icon-'));
const page = join(dir, 'icon.html');
writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}svg{display:block;width:${SIZE}px;height:${SIZE}px}</style>${svg}`);
const out = resolve(here, '../media/icon.png');
execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000',
  `--screenshot=${out}`, `--window-size=${SIZE},${SIZE}`, pathToFileURL(page).href], { stdio: 'inherit' });
console.log('wrote', out);
