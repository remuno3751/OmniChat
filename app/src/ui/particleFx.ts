/*
 * "Particles to text" (web only). Newly revealed characters are wrapped by renderParticles() in `.oc-pchunk` spans whose
 * glyphs are hidden at first. For every character a few dots start scattered around its position on a fixed canvas overlay,
 * fly in along varied paths (straight, spiral, wobble, overshoot, falling) and land on it while the glyph fades in
 * underneath, so the text visibly condenses out of the particles.
 * Targets are re-measured every frame (offsets are relative to the character), so scrolling or layout shifts while the
 * answer grows do not detach the particles from the text.
 */

import { getDevice } from '../deviceSettings';
import { sampleEvenly } from './particleSample';
import type { ThemeId } from '../deviceSettings';

type Motion = 'fly' | 'spiral' | 'wobble' | 'overshoot' | 'fall';

interface Particle {
  node: Text;
  idx: number;
  ox: number; // start offset from the target (px)
  oy: number;
  t0: number;
  dur: number;
  size: number;
  color: string;
  tx: number; // last known target
  ty: number;
  motion: Motion;
  power: number; // easing exponent
  turn: number; // spiral: turns (signed)
  amp: number; // wobble: sideways amplitude in px
  freq: number; // wobble / twinkle frequency
  phase: number;
}

/** Per-theme color presets (Settings > Appearance > particle color > Theme preset). Each particle picks one at random. */
export const PARTICLE_PRESETS: Record<ThemeId, string[]> = {
  simple: ['#10a37f', '#19c37d', '#7ee0c0', '#9aa0a6', '#5b8def'],
  frontier: ['#c8af23', '#fffa00', '#ffffff', '#8a8a8a', '#e6d36a'],
  astral: ['#f9c837', '#f4a747', '#c9a6ff', '#7fd1ff', '#fbe9b6'],
};

/** Quick swatches for the custom color. */
export const PARTICLE_SWATCHES = ['#10a37f', '#f9c837', '#fffa00', '#ff6b9a', '#7fd1ff', '#c9a6ff', '#ffffff', '#ff8a3d'];

export const isHexColor = (s: string) => /^#[0-9a-fA-F]{6}$/.test(s);

const BASE_PER_CHAR = 4;
const MAX_CHARS_PER_CHUNK = 48;
/** per-frame budget: a big chunk (fast generation) gets fewer particles per character instead of none for most of its text */
const MAX_NEW_PARTICLES = 220;
const MAX_PARTICLES = 800;

let installed = false;
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let parts: Particle[] = [];
let raf = 0;
let dpr = 1;
const range = typeof document !== 'undefined' ? document.createRange() : (null as unknown as Range);

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

function ensureCanvas(): void {
  if (canvas) return;
  canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483000';
  document.body.appendChild(canvas);
  ctx = canvas.getContext('2d');
  resize();
  window.addEventListener('resize', resize);
}

function resize(): void {
  if (!canvas) return;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
}

function charRect(node: Text, idx: number): DOMRect | null {
  try {
    range.setStart(node, idx);
    range.setEnd(node, idx + 1);
    const r = range.getBoundingClientRect();
    return r.width > 0 || r.height > 0 ? r : null;
  } catch { return null; }
}

/** Slightly varies a #rrggbb color so a single custom color still shimmers. */
function jitter(hex: string): string {
  const k = rnd(0.8, 1.15);
  const c = (i: number) => Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(i, i + 2), 16) * k)));
  return `rgb(${c(1)},${c(3)},${c(5)})`;
}

function pickMotion(): Motion {
  const r = Math.random();
  return r < 0.34 ? 'fly' : r < 0.58 ? 'spiral' : r < 0.78 ? 'wobble' : r < 0.9 ? 'overshoot' : 'fall';
}

function spawn(el: HTMLElement): void {
  if (el.dataset.ocp) return;
  el.dataset.ocp = '1';
  const node = el.firstChild;
  if (!node || node.nodeType !== 3) return;
  const text = node as Text;
  const dev = getDevice();
  const textColor = getComputedStyle(el).color || '#888';
  const palette = PARTICLE_PRESETS[dev.themeId] ?? PARTICLE_PRESETS.simple;
  const colorFor = (): string => {
    if (dev.particleColorMode === 'custom' && isHexColor(dev.particleColor)) return jitter(dev.particleColor);
    if (dev.particleColorMode === 'preset') return pick(palette);
    return textColor;
  };
  const sizeK = dev.particleSize;
  const inten = dev.particleIntensity;
  const perChar = Math.max(1, Math.round(BASE_PER_CHAR * inten));
  const spread = 0.55 + 0.45 * inten;
  const now = performance.now();
  const s = text.data;
  const cands: number[] = [];
  for (let i = 0; i < s.length; i++) if (!/\s/.test(s[i])) cands.push(i);
  // a long chunk (fast generation) is sampled over its whole length, not just its first characters
  const picked = sampleEvenly(cands.length, Math.min(MAX_CHARS_PER_CHUNK, Math.max(1, Math.floor(MAX_NEW_PARTICLES / perChar))));
  for (const pi of picked) {
    const i = cands[pi];
    const r = charRect(text, i);
    if (!r) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    for (let k = 0; k < perChar; k++) {
      const motion = pickMotion();
      const a = Math.random() * Math.PI * 2;
      // most particles start close, a few far away (long-tailed distribution)
      const far = Math.random() < 0.18 ? rnd(1.6, 2.6) : 1;
      const d = rnd(14, 60) * spread * far;
      let ox = Math.cos(a) * d;
      let oy = Math.sin(a) * d;
      if (motion === 'fall') { ox *= 0.5; oy = -Math.abs(oy) - rnd(20, 50) * spread; }
      parts.push({
        node: text, idx: i,
        ox, oy: oy - 4,
        t0: now + Math.random() * 220 * (Math.random() < 0.3 ? 2 : 1),
        dur: rnd(240, 560),
        size: rnd(0.8, 1.9) * sizeK * (Math.random() < 0.12 ? 1.8 : 1),
        color: colorFor(),
        tx: cx, ty: cy,
        motion,
        power: rnd(2, 4),
        turn: (Math.random() < 0.5 ? -1 : 1) * rnd(0.35, 1.1),
        amp: rnd(5, 18) * spread,
        freq: rnd(1.5, 3.5),
        phase: Math.random() * Math.PI * 2,
      });
    }
  }
  if (parts.length > MAX_PARTICLES) parts.splice(0, parts.length - MAX_PARTICLES);
  if (!raf && parts.length) { ensureCanvas(); raf = requestAnimationFrame(frame); }
}

const easeOut = (t: number, p: number) => 1 - Math.pow(1 - t, p);
const easeOutBack = (t: number) => { const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function frame(now: number): void {
  raf = 0;
  if (!ctx || !canvas) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
  const next: Particle[] = [];
  for (const p of parts) {
    const t = (now - p.t0) / p.dur;
    if (t >= 1) continue;
    next.push(p);
    if (t < 0) continue;
    if (p.node.isConnected) {
      const r = charRect(p.node, p.idx);
      if (r) { p.tx = r.left + r.width / 2; p.ty = r.top + r.height / 2; }
    }
    let x: number;
    let y: number;
    switch (p.motion) {
      case 'spiral': {
        const e = easeOut(t, p.power);
        const k = 1 - e;
        const ang = p.turn * Math.PI * 2 * k;
        const c = Math.cos(ang);
        const sn = Math.sin(ang);
        x = p.tx + (p.ox * c - p.oy * sn) * k;
        y = p.ty + (p.ox * sn + p.oy * c) * k;
        break;
      }
      case 'wobble': {
        const e = easeOut(t, p.power);
        const k = 1 - e;
        const side = Math.sin(t * Math.PI * p.freq * 2 + p.phase) * p.amp * k;
        const len = Math.hypot(p.ox, p.oy) || 1;
        x = p.tx + p.ox * k + (-p.oy / len) * side;
        y = p.ty + p.oy * k + (p.ox / len) * side;
        break;
      }
      case 'overshoot': {
        const k = 1 - easeOutBack(t);
        x = p.tx + p.ox * k;
        y = p.ty + p.oy * k;
        break;
      }
      case 'fall': {
        const k = 1 - easeInOut(t);
        x = p.tx + p.ox * k;
        y = p.ty + p.oy * k;
        break;
      }
      default: {
        const k = 1 - easeOut(t, p.power);
        x = p.tx + p.ox * k;
        y = p.ty + p.oy * k;
      }
    }
    const twinkle = 0.75 + 0.35 * Math.sin(t * Math.PI * p.freq * 2 + p.phase);
    const alpha = (t < 0.15 ? t / 0.15 : t > 0.8 ? (1 - t) / 0.2 : 1) * 0.95 * (0.8 + 0.2 * twinkle);
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.3, p.size * (0.55 + 0.45 * (1 - t) + 0.25) * twinkle), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  parts = next;
  if (parts.length) raf = requestAnimationFrame(frame);
  else ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
}

function scan(n: Node): void {
  if (n.nodeType !== 1) return;
  const el = n as HTMLElement;
  if (el.classList.contains('oc-pchunk')) spawn(el);
  el.querySelectorAll?.('.oc-pchunk').forEach((c) => spawn(c as HTMLElement));
}

/** Starts watching the document for new particle chunks (idempotent, web only). */
export function startParticleFx(): void {
  if (installed || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
  installed = true;
  new MutationObserver((muts) => {
    for (const m of muts) m.addedNodes.forEach(scan);
  }).observe(document.body, { childList: true, subtree: true });
}
