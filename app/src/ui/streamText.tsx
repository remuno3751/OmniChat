import React, { useEffect, useRef, useState } from 'react';
import { Platform, Text } from 'react-native';
import { useDevice } from '../deviceSettings';
import type { StreamAnim } from '../deviceSettings';
import { useThemeDef } from '../theme';
import { resolveStreamAnim } from './motionLevel';
import { safeCut, stepReveal } from '../streamReveal';
import { startParticleFx } from './particleFx';
import { chunkAlive } from './particleSample';

/** Settings > Appearance > Streaming animation, resolved against Animation amount / prefers-reduced-motion / platform. */
export function useStreamAnim(): 'off' | 'smooth' | 'particles' {
  const mode = useDevice((s) => s.streamAnim);
  const th = useThemeDef();
  return resolveStreamAnim(mode, th.mo, Platform.OS === 'web');
}

// Particle chunks are tagged inside the text by private-use marker chars (U+E000..) and rendered by renderParticles().
const MARK0 = 0xe000;
const MARK_SPAN = 4000;
const MAX_CHUNKS = 10;
const CHUNK_LIFE_MS = 420;
export const MARK_RE = /[-]/;
export const MARK_ALL = /[-]/g;
export const stripMarks = (s: string) => (MARK_RE.test(s) ? s.replace(MARK_ALL, '') : s);

interface Chunk { at: number; ts: number; id: number }

/**
 * Text to render while a reply streams. 'smooth': deltas are buffered and revealed on requestAnimationFrame at an adaptive
 * rate (streamReveal.ts); 'particles': same, plus markers in front of the characters revealed in the last ~400 ms.
 * Not streaming or 'off' → the full text at once (instant flush on completion).
 */
export function useStreamText(text: string, streaming: boolean, force?: StreamAnim): string {
  const base = useStreamAnim();
  const th = useThemeDef();
  // `force` is for the settings preview: it overrides the chosen mode but still obeys Animation amount / reduce-motion / platform
  const anim = force ? resolveStreamAnim(force, th.mo, Platform.OS === 'web') : base;
  const active = streaming && anim !== 'off';
  const [, bump] = useState(0);
  const st = useRef({ shown: 0, carry: 0, chunks: [] as Chunk[], nextId: 0, wasActive: false });
  const s = st.current;
  if (!active) { s.wasActive = false; s.shown = 0; s.carry = 0; s.chunks = []; }
  else if (!s.wasActive) { s.wasActive = true; s.shown = safeCut(text, text.length > 400 ? text.length - 400 : 0); s.chunks = []; } // joining mid-stream (reopened chat) shows the older part at once
  if (s.shown > text.length) s.shown = text.length;

  useEffect(() => {
    if (!active || typeof requestAnimationFrame !== 'function') return;
    let raf = 0;
    let last = typeof performance !== 'undefined' ? performance.now() : Date.now();
    let acc = 0;
    const tick = (now: number) => {
      acc += now - last; last = now;
      if (acc >= 28) { // ~30 commits/s keeps the Markdown re-parse cheap
        const r = stepReveal(text, s.shown, acc, s.carry);
        acc = 0;
        s.carry = r.carry;
        if (r.shown !== s.shown) {
          if (anim === 'particles') {
            s.chunks.push({ at: s.shown, ts: now, id: s.nextId++ });
            if (s.chunks.length > MAX_CHUNKS) s.chunks.shift();
          }
          s.shown = r.shown;
          bump((n) => (n + 1) & 0xffff);
        }
      }
      if (s.shown < text.length) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, active, anim, s]);

  if (!active) return text;
  const shown = text.slice(0, s.shown);
  if (anim !== 'particles' || !s.chunks.length) return shown;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let out = '';
  let from = 0;
  for (let ci = 0; ci < s.chunks.length; ci++) {
    const c = s.chunks[ci];
    if (!chunkAlive(now - c.ts, s.chunks.length - 1 - ci, CHUNK_LIFE_MS) || c.at >= shown.length || c.at < from) continue;
    out += shown.slice(from, c.at) + String.fromCharCode(MARK0 + (c.id % MARK_SPAN));
    from = c.at;
  }
  return out + shown.slice(from);
}

let cssDone = false;
function ensureCss() {
  if (cssDone || Platform.OS !== 'web' || typeof document === 'undefined') return;
  cssDone = true;
  const el = document.createElement('style');
  el.textContent = '@keyframes oc-condense{0%,40%{opacity:0}100%{opacity:1}}.oc-pchunk{animation:oc-condense 420ms ease-out both}@media (prefers-reduced-motion:reduce){.oc-pchunk{animation:none}}';
  document.head.appendChild(el);
  startParticleFx();
}

/** Splits a string at particle markers: text after a marker is wrapped in an animated span. `state.open` carries across leaves. */
export function renderParticles(n: string, key: string, state: { open: boolean }): React.ReactNode {
  if (!state.open && !MARK_RE.test(n)) return n;
  ensureCss();
  const out: React.ReactNode[] = [];
  let id = 'x';
  let buf = '';
  const flush = () => {
    if (!buf) return;
    out.push(state.open && Platform.OS === 'web'
      ? React.createElement('span', { key: `${key}-${id}-${out.length}`, className: 'oc-pchunk' }, buf)
      : <React.Fragment key={`${key}-${out.length}`}>{buf}</React.Fragment>);
    buf = '';
  };
  for (const ch of n) {
    const c = ch.charCodeAt(0);
    if (c >= MARK0 && c < MARK0 + MARK_SPAN) { flush(); state.open = true; id = String(c); continue; }
    buf += ch;
  }
  flush();
  return out;
}
