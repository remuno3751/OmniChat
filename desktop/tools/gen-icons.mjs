// Generates the OmniChat PLACEHOLDER icons (no dependencies). Replace with real artwork when available.
//   node desktop/tools/gen-icons.mjs
// Then (desktop app icons):  cd desktop && npx tauri icon src-tauri/app-icon.png
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Glyph: a ring ("O") with a small chat-bubble tail. Coordinates are centered, unit = canvas size.
function glyph(x, y) {
  const r = Math.hypot(x, y);
  if (Math.abs(r - 0.25) <= 0.045) return true;
  // tail triangle at lower right
  const A = [0.13, 0.19], B = [0.30, 0.33], C = [0.2, 0.1];
  const s = (p, a, b) => (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
  const p = [x, y], d1 = s(p, A, B), d2 = s(p, B, C), d3 = s(p, C, A);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}
const lerp = (a, b, t) => a + (b - a) * t;

/** mode: 'icon' opaque square | 'rounded' transparent corners | 'fg' transparent bg | 'mono' white on transparent */
function render(size, { mode, scale }) {
  const out = Buffer.alloc(size * size * 4);
  const SS = 3;
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let R = 0, G = 0, B = 0, A = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const u = (px + (sx + 0.5) / SS) / size, v = (py + (sy + 0.5) / SS) / size;
      let inside = true;
      if (mode === 'rounded') {
        const rr = 0.2, qx = Math.abs(u - 0.5) - (0.5 - rr), qy = Math.abs(v - 0.5) - (0.5 - rr);
        inside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) <= rr;
      }
      const g = glyph((u - 0.5) / scale, (v - 0.5) / scale);
      let c = null;
      if (mode === 'icon' || mode === 'rounded') {
        if (!inside) continue;
        c = g ? [255, 255, 255, 255] : [lerp(99, 67, v), lerp(102, 56, v), lerp(241, 202, v), 255];
      } else if (g) c = [255, 255, 255, 255];
      if (!c) continue;
      R += c[0]; G += c[1]; B += c[2]; A += c[3];
    }
    const n = SS * SS, o = (py * size + px) * 4;
    const a = A / n;
    out[o] = a ? Math.round(R / (A / 255)) : 0; out[o + 1] = a ? Math.round(G / (A / 255)) : 0; out[o + 2] = a ? Math.round(B / (A / 255)) : 0; out[o + 3] = Math.round(a);
  }
  return png(size, size, out);
}

function emit(rel, size, opts) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, render(size, opts));
  console.log('wrote', rel);
}

// Desktop source icon (tauri icon input)
emit('desktop/src-tauri/app-icon.png', 1024, { mode: 'rounded', scale: 1 });
// PWA / web
emit('app/public/icons/icon-192.png', 192, { mode: 'icon', scale: 1 });
emit('app/public/icons/icon-512.png', 512, { mode: 'icon', scale: 1 });
emit('app/public/icons/maskable-512.png', 512, { mode: 'icon', scale: 0.78 });
emit('app/public/icons/apple-touch-icon.png', 180, { mode: 'icon', scale: 0.9 });
emit('app/public/favicon-32.png', 32, { mode: 'rounded', scale: 1 });
// Expo / Android (new files, the Expo template assets are left untouched)
emit('app/assets/omnichat-icon.png', 1024, { mode: 'icon', scale: 1 });
emit('app/assets/omnichat-adaptive-foreground.png', 1024, { mode: 'fg', scale: 0.55 });
emit('app/assets/omnichat-adaptive-monochrome.png', 1024, { mode: 'mono', scale: 0.55 });
