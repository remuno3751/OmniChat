// Generates every OmniChat icon PNG (client app, web, desktop, server app) from one SVG design.
// Run from the repo root with Playwright available:  node app/scripts/gen-icons.mjs
// then regenerate the Tauri icon sets:  (cd desktop && npx tauri icon src-tauri/app-icon.png -o src-tauri/icons)
//                                      (cd server-app && npx tauri icon src-tauri/app-icon.png -o src-tauri/icons)
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// CommonJS require so a globally installed Playwright works too (NODE_PATH=$(npm root -g)).
// Without Playwright, headless Chrome / Edge renders the PNGs (see renderWithChrome below).
let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* use Chrome */ }
// node app/scripts/gen-icons.mjs --only=frontier-light,astral-light   (only those variants; the default / server / web icons are skipped)
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Variants: one per theme + mode. Keep ids in sync with app/src/appIcon.ts and desktop/src-tauri/src/lib.rs.
export const VARIANTS = {
  'simple-light': { g: ['#06775c', '#3ddc97'], fg: '#fff', mk: '#fff', rx: 112 },
  'simple-dark': { g: ['#0a0a0c', '#134a37'], fg: '#19c37d', mk: '#19c37d', rx: 112 },
  'simple-sepia': { g: ['#fbf5e6', '#d6b780'], fg: '#8a5a2b', mk: '#8a5a2b', rx: 112 },
  'simple-contrast': { g: ['#000000', '#4a3d00'], fg: '#ffd400', mk: '#ffd400', rx: 112 },
  'frontier-light': { g: ['#ffffff', '#d6d6c4'], fg: '#191919', mk: '#191919', rx: 28, edge: '#a9a995' },
  'frontier-dark': { g: ['#0c0d0f', '#3d3d14'], fg: '#fffa00', mk: '#c8af23', rx: 28 },
  'astral-light': { g: ['#fdfaf3', '#e8c98c'], fg: '#c99a1a', mk: '#8a7545', rx: 112, edge: '#d3bd8a' },
  'astral-dark': { g: ['#161b2b', '#3f3f86'], fg: '#f9c837', mk: '#fbe9b6', rx: 112 },
};
const SERVER = { g: ['#2e2a85', '#6366f1'], fg: '#fff', mk: '#fff', rx: 112, server: true };
const DEFAULT = 'simple-light';

const CX = 232, CY = 250, R = 176, r = 118, B = CY + R;

// The bubble tail: leaves the ring at angle a, hugs the circle, then sweeps out to a sharp tip on the baseline.
function tail(a, k1, k2, L, h) {
  const T = CX + R * L, rad = (a * Math.PI) / 180;
  const x = CX + R * Math.cos(rad), y = CY + R * Math.sin(rad);
  return `M${x} ${y} C${x - Math.sin(rad) * k1} ${y + Math.cos(rad) * k1} ${T - k2} ${B - h} ${T} ${B} L${CX} ${B} Z`;
}
const TAIL = tail(17, 38, 85, 1.3, 26);

// Corner patches: dots top-right, plus marks bottom-left, fading toward the center.
function patch(corner, kind, c) {
  let o = '';
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    if (i + j > 3) continue;
    const x = corner === 'tr' ? 468 - i * 30 : 44 + i * 30, y = corner === 'tr' ? 44 + j * 30 : 468 - j * 30;
    const op = (0.6 - (i + j) * 0.13).toFixed(2);
    o += kind === 'dot'
      ? `<circle cx="${x}" cy="${y}" r="7" fill="${c}" opacity="${op}"/>`
      : `<path d="M${x} ${y - 9}v18M${x - 9} ${y}h18" stroke="${c}" stroke-width="5" opacity="${op}"/>`;
  }
  return o;
}

// Inside the ring: chat lines (right/left aligned like a conversation), or server rack rows for the server app.
function inner(v, mono) {
  const c = v.fg;
  if (v.server) {
    return [-44, 0, 44].map((dy) =>
      `<rect x="${CX - 70}" y="${CY + dy - 14}" width="140" height="28" rx="14" fill="${c}" opacity="${mono ? 1 : 0.45}"/>` +
      `<circle cx="${CX - 50}" cy="${CY + dy}" r="7" fill="${c}"/>`).join('');
  }
  const lines = [[-54, -20, 72, 1], [-18, -88, 30, 0], [18, -30, 88, 1], [54, -72, -10, 0]];
  return lines.map(([dy, x1, x2, right]) =>
    `<rect x="${CX + x1}" y="${CY + dy - 10}" width="${x2 - x1}" height="20" rx="10" fill="${c}" opacity="${mono ? 1 : right ? 0.7 : 0.35}"/>`).join('');
}

/**
 * kind: 'full' (square, full bleed: OS masks it), 'rounded' (own rounded corners, transparent outside, padded),
 * 'adaptive' (Android foreground: full-bleed background, artwork shrunk into the safe zone), 'mono' (Android monochrome).
 */
function svg(v, kind) {
  const mono = kind === 'mono';
  const fg = mono ? { ...v, fg: '#fff', mk: '#fff' } : v;
  const art = `<mask id="m"><rect width="512" height="512" fill="#000"/><circle cx="${CX}" cy="${CY}" r="${R}" fill="#fff"/>` +
    `<path d="${TAIL}" fill="#fff"/><circle cx="${CX}" cy="${CY}" r="${r}" fill="#000"/></mask>` +
    `<rect width="512" height="512" fill="${fg.fg}" mask="url(#m)"/>${inner(fg, mono)}`;
  const pats = patch('tr', 'dot', v.mk) + patch('bl', 'plus', v.mk);
  const bg = (rx, edge) => `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${v.g[0]}"/>` +
    `<stop offset="1" stop-color="${v.g[1]}"/></linearGradient></defs>` +
    (edge && v.edge ? `<rect x="2" y="2" width="508" height="508" rx="${rx}" fill="url(#g)" stroke="${v.edge}" stroke-width="4"/>` : `<rect width="512" height="512" rx="${rx}" fill="url(#g)"/>`);
  let body;
  if (kind === 'full') body = bg(0) + pats + art;
  else if (kind === 'rounded') body = `<g transform="translate(51.2 51.2) scale(0.8)">${bg(v.rx, true)}${pats}${art}</g>`;
  else if (kind === 'adaptive') body = bg(0) + `<g transform="translate(256 256) scale(0.62) translate(-256 -256)">${pats}${art}</g>`;
  else body = `<g transform="translate(256 256) scale(0.62) translate(-256 -256)">${art}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${body}</svg>`;
}

const jobs = [];
const out = (path, v, kind, size) => jobs.push({ path: join(ROOT, path), html: svg(v, kind), size });

for (const [id, v] of Object.entries(VARIANTS)) {
  if (ONLY.length && !ONLY.includes(id)) continue;
  out(`app/assets/app-icons/${id}.png`, v, 'full', 1024);
  out(`app/assets/app-icons/${id}-foreground.png`, v, 'adaptive', 1024);
  out(`app/public/icons/app/${id}.png`, v, 'rounded', 192);
  out(`desktop/src-tauri/icons/variants/${id}.png`, v, 'rounded', 256);
}
const d = VARIANTS[DEFAULT];
if (!ONLY.length) {
out('app/assets/omnichat-icon.png', d, 'full', 1024);
out('app/assets/omnichat-adaptive-foreground.png', d, 'adaptive', 1024);
out('app/assets/omnichat-adaptive-monochrome.png', d, 'mono', 1024);
out('app/assets/favicon.png', d, 'rounded', 48);
out('app/public/favicon-32.png', d, 'rounded', 32);
out('app/public/icons/apple-touch-icon.png', d, 'full', 180);
out('app/public/icons/icon-192.png', d, 'rounded', 192);
out('app/public/icons/icon-512.png', d, 'rounded', 512);
out('app/public/icons/maskable-512.png', d, 'adaptive', 512);
out('desktop/src-tauri/app-icon.png', d, 'rounded', 1024);
out('server-app/src-tauri/app-icon.png', SERVER, 'rounded', 1024);
}

async function renderWithChrome() {
  const { execFileSync } = await import('node:child_process');
  const { existsSync, writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find(existsSync);
  if (!exe) throw new Error('Neither Playwright nor Chrome / Edge was found');
  const tmp = mkdtempSync(join(tmpdir(), 'omni-icons-'));
  for (const [i, j] of jobs.entries()) {
    mkdirSync(dirname(j.path), { recursive: true });
    const html = join(tmp, i + '.html');
    writeFileSync(html, `<style>html,body{margin:0;background:transparent}svg{width:${j.size}px;height:${j.size}px;display:block}</style>${j.html}`);
    execFileSync(exe, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', `--window-size=${j.size},${j.size}`,
      '--default-background-color=00000000', `--screenshot=${j.path}`, pathToFileURL(html).href], { stdio: 'ignore' });
  }
}

if (!chromium) {
  await renderWithChrome();
} else {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const j of jobs) {
    mkdirSync(dirname(j.path), { recursive: true });
    await page.setViewportSize({ width: j.size, height: j.size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${j.size}px;height:${j.size}px;display:block}</style>${j.html}`);
    await page.screenshot({ path: j.path, omitBackground: true });
  }
  await browser.close();
}
console.log(`wrote ${jobs.length} icons`);
