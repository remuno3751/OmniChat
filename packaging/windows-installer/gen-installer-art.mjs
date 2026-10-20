// Generates the Frontier-style artwork of the Windows installers (NSIS sidebar 164x314 and header 150x57, 24-bit BMP).
// Needs Chrome or Edge (headless screenshot) and `pngjs` (from app/node_modules). Run from the repo root:
//   node packaging/windows-installer/gen-installer-art.mjs
// Output: {server-app,desktop}/src-tauri/windows/{sidebar,header}.bmp  (commit the result)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { PNG } = createRequire(join(ROOT, 'app', 'package.json'))('pngjs');
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find(existsSync);
if (!CHROME) throw new Error('Chrome or Edge not found');

const LOGO = pathToFileURL(join(ROOT, 'app', 'assets', 'app-icons', 'frontier-dark.png')).href;
const BG = '#0c0d0f', YEL = '#fffa00', DIM = '#8a8a8a';

const base = `
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:${BG};overflow:hidden;font-family:"Segoe UI","Helvetica Neue",Arial,sans-serif;position:relative}
  .hatch{position:absolute;inset:0;background:repeating-linear-gradient(135deg,transparent 0 6px,#15161a 6px 7px)}
  .stripe{position:absolute;left:0;right:0;height:10px;background:repeating-linear-gradient(135deg,${YEL} 0 6px,#0c0d0f 6px 12px)}
`;

const sidebar = (label) => `<!doctype html><meta charset="utf-8"><style>${base}
  body{width:164px;height:314px}
  .logo{position:absolute;left:46px;top:40px;width:72px;height:72px;border-radius:14px}
  .bar{position:absolute;left:20px;top:138px;width:36px;height:4px;background:${YEL}}
  .t{position:absolute;left:20px;top:150px;color:${YEL};font-weight:700;font-size:20px;letter-spacing:3px}
  .s{position:absolute;left:20px;top:180px;color:#f2f2f2;font-size:11px;letter-spacing:5px;font-weight:600}
  .rule{position:absolute;left:20px;right:20px;top:206px;height:1px;background:#3a3b40}
  .m{position:absolute;left:20px;top:216px;color:${DIM};font:10px/16px Consolas,"Courier New",monospace;letter-spacing:1px}
  .stripe{top:0}
  .fade{position:absolute;top:0;bottom:0;right:0;width:40px;background:linear-gradient(90deg,transparent,${BG})}
  .corner{position:absolute;right:14px;top:22px;width:14px;height:14px;border-top:2px solid ${YEL};border-right:2px solid ${YEL}}
</style><div class="hatch"></div><div class="fade"></div><div class="corner"></div>
<img class="logo" src="${LOGO}"><div class="bar"></div>
<div class="t">OMNICHAT</div><div class="s">${label}</div><div class="rule"></div>
<div class="m">&gt; INSTALL<br>&gt; READY</div><div class="stripe"></div>`;

const header = (label) => `<!doctype html><meta charset="utf-8"><style>${base}
  body{width:150px;height:57px}
  .logo{position:absolute;right:10px;top:10px;width:37px;height:37px;border-radius:8px}
  .bar{position:absolute;left:12px;top:15px;width:3px;height:27px;background:${YEL}}
  .t{position:absolute;left:22px;top:13px;color:${YEL};font-weight:700;font-size:11px;letter-spacing:1px}
  .s{position:absolute;left:22px;top:30px;color:#f2f2f2;font-size:8px;letter-spacing:3px;font-weight:600}
  .stripe{bottom:0;height:4px;background:repeating-linear-gradient(135deg,${YEL} 0 4px,#0c0d0f 4px 8px)}
</style><div class="hatch"></div><div class="bar"></div>
<div class="t">OMNICHAT</div><div class="s">${label}</div><img class="logo" src="${LOGO}"><div class="stripe"></div>`;

const tmp = join(ROOT, '.release', 'installer-art');
mkdirSync(tmp, { recursive: true });

function render(name, html, w, h) {
  const htmlPath = join(tmp, name + '.html');
  const pngPath = join(tmp, name + '.png');
  writeFileSync(htmlPath, html);
  rmSync(pngPath, { force: true });
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    `--window-size=${w},${h}`, `--screenshot=${pngPath}`, '--default-background-color=0c0d0fff', pathToFileURL(htmlPath).href,
  ], { stdio: 'ignore' });
  const png = PNG.sync.read(readFileSync(pngPath));
  if (png.width < w || png.height < h) throw new Error(`${name}: screenshot is ${png.width}x${png.height}, expected ${w}x${h}`);
  return { png, w, h };
}

/** 24-bit bottom-up BMP, cropped to w x h (the screenshot may be larger than the window). */
function toBmp({ png, w, h }) {
  const rowBytes = Math.ceil((w * 3) / 4) * 4;
  const out = Buffer.alloc(54 + rowBytes * h);
  out.write('BM', 0); out.writeUInt32LE(out.length, 2); out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14); out.writeInt32LE(w, 18); out.writeInt32LE(h, 22);
  out.writeUInt16LE(1, 26); out.writeUInt16LE(24, 28); out.writeUInt32LE(rowBytes * h, 34);
  out.writeInt32LE(2835, 38); out.writeInt32LE(2835, 42);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * png.width + x) * 4;
      const a = png.data[i + 3] / 255;
      const px = (c, bg) => Math.round(png.data[i + c] * a + bg * (1 - a));
      const o = 54 + (h - 1 - y) * rowBytes + x * 3;
      out[o] = px(2, 0x0f); out[o + 1] = px(1, 0x0d); out[o + 2] = px(0, 0x0c);
    }
  }
  return out;
}

const targets = [
  { dir: 'server-app/src-tauri/windows', label: 'SERVER' },
  { dir: 'desktop/src-tauri/windows', label: 'CLIENT' },
];
for (const t of targets) {
  const dir = join(ROOT, t.dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sidebar.bmp'), toBmp(render('sidebar-' + t.label, sidebar(t.label), 164, 314)));
  writeFileSync(join(dir, 'header.bmp'), toBmp(render('header-' + t.label, header(t.label), 150, 57)));
  console.log('wrote', t.dir + '/{sidebar,header}.bmp');
}
