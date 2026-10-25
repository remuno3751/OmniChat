import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image, Platform, View, type ViewProps } from 'react-native';
import { apiV4 } from '../apiV4';
import type { PetActivity } from '../deviceSettings';
import { PET_ROW_FOR_MODE, PET_ROWS, petStateKey, type PetMode } from '../petState';
import type { StillState } from '../petStills';
import type { PetInfo } from '../protocol';

// Sprite sheet geometry (PROTOCOL-v4 section 9): 8 columns of 192x208 cells.
export const CELL_W = 192;
export const CELL_H = 208;
export const SHEET_W = 1536;
export const SHEET_H: Record<1 | 2, number> = { 1: 1872, 2: 2288 };

/** Frame time multiplier per activity level. */
const ACTIVITY_SCALE: Record<PetActivity, number> = { low: 2, normal: 1, high: 0.8 };

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
/** One full cycle of the waving row (a wave lasts this long). */
export const WAVE_MS = sum(PET_ROWS[3]);

/** Height of the pet's box for a given width: a stills image is square, a sprite cell is 192x208. */
export function petBoxHeight(stills: boolean, size: number): number {
  return stills ? size : size * CELL_H / CELL_W;
}

/**
 * Motion per stills state. `bob` is the vertical travel as a fraction of the image size (from, to);
 * `sway` is the rotation in degrees; `pulse` the extra scale; `half` the ms for one half cycle;
 * `once` plays one jump (no loop); `shake` a horizontal shake that then rests.
 */
interface StillFx { half: number; once?: boolean; shake?: boolean; bob?: [number, number]; sway?: number; pulse?: number }
const STILL_FX: Record<StillState, StillFx> = {
  idle: { half: 1200, bob: [-0.02, 0.02] },
  thinking: { half: 1600, sway: 3 },
  working: { half: 250, bob: [-0.02, 0.02] },
  tool: { half: 500, pulse: 0.06 },
  done: { half: 260, once: true, bob: [0, -0.08] },
  error: { half: 60, once: true, shake: true },
};

/** True while the web page is hidden; animation pauses then. Always false on native. */
function usePageHidden(): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const doc = Platform.OS === 'web' ? (globalThis as any).document : undefined;
    if (!doc) return;
    const on = () => setHidden(!!doc.hidden);
    on();
    doc.addEventListener('visibilitychange', on);
    return () => doc.removeEventListener('visibilitychange', on);
  }, []);
  return hidden;
}

/** Reduced motion: web prefers-reduced-motion; native low activity acts as low-power mode. */
function useReducedMotion(activity: PetActivity): boolean {
  const web = Platform.OS === 'web';
  const [prefers, setPrefers] = useState(false);
  useEffect(() => {
    if (!web) return;
    let mql: any;
    try { mql = (globalThis as any).matchMedia?.('(prefers-reduced-motion: reduce)'); } catch { mql = undefined; }
    if (!mql) return;
    const on = () => setPrefers(!!mql.matches);
    on();
    mql.addEventListener?.('change', on);
    return () => mql.removeEventListener?.('change', on);
  }, [web]);
  return web ? prefers : activity === 'low';
}

/** Image URL for one state of a stills pet. Falls back to idle when the state was not uploaded or fails to load. */
function useStillUrl(id: string, state: StillState, states: string[] | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const wanted: StillState = states?.includes(state) ? state : 'idle';
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const u = await apiV4.petImageBlobUrl(id, wanted);
        if (alive) setUrl(u);
      } catch {
        if (alive && wanted !== 'idle') {
          try {
            const u = await apiV4.petImageBlobUrl(id, 'idle');
            if (alive) setUrl(u);
          } catch { /* keep the previous image */ }
        }
      }
    })();
    return () => { alive = false; };
  }, [id, wanted]);
  return url;
}

/**
 * Stills body: the image for the current state, animated per state. Motion uses one looping or one-shot
 * Animated.Value (position phase 0..1, and -1..1 for the shake). Reduced motion and a hidden page
 * show the still image without animation.
 */
function StillBody({ id, states, state, size, activity, still }: {
  id: string; states: string[] | undefined; state: StillState; size: number; activity: PetActivity; still: boolean;
}) {
  const url = useStillUrl(id, state, states);
  const phase = useRef(new Animated.Value(0)).current;
  const shake = useRef(new Animated.Value(0)).current;
  const fx = STILL_FX[state];

  useEffect(() => {
    phase.setValue(0);
    shake.setValue(0);
    if (!still) return;
    const k = ACTIVITY_SCALE[activity];
    const native = Platform.OS !== 'web';
    let anim: Animated.CompositeAnimation;
    if (fx.shake) {
      anim = Animated.sequence([-1, 1, -1, 1, 0].map((v) =>
        Animated.timing(shake, { toValue: v, duration: fx.half * k, useNativeDriver: native })));
    } else if (fx.once) {
      anim = Animated.sequence([
        Animated.timing(phase, { toValue: 1, duration: fx.half * k, easing: Easing.out(Easing.quad), useNativeDriver: native }),
        Animated.timing(phase, { toValue: 0, duration: fx.half * k, easing: Easing.in(Easing.quad), useNativeDriver: native }),
      ]);
    } else {
      anim = Animated.loop(Animated.sequence([
        Animated.timing(phase, { toValue: 1, duration: fx.half * k, easing: Easing.inOut(Easing.sin), useNativeDriver: native }),
        Animated.timing(phase, { toValue: 0, duration: fx.half * k, easing: Easing.inOut(Easing.sin), useNativeDriver: native }),
      ]));
    }
    anim.start();
    return () => { anim.stop(); };
  }, [state, still, activity, phase, shake, fx]);

  const [from, to] = fx.bob ?? [0, 0];
  const sway = fx.sway ?? 0;
  const transform = [
    { translateX: shake.interpolate({ inputRange: [-1, 1], outputRange: [-0.04 * size, 0.04 * size] }) },
    { translateY: phase.interpolate({ inputRange: [0, 1], outputRange: [from * size, to * size] }) },
    { rotate: phase.interpolate({ inputRange: [0, 1], outputRange: [`${-sway}deg`, `${sway}deg`] }) },
    { scale: phase.interpolate({ inputRange: [0, 1], outputRange: [1, 1 + (fx.pulse ?? 0)] }) },
  ];
  if (!url) return null;
  return (
    <Animated.Image
      source={{ uri: url }}
      resizeMode="contain"
      accessibilityIgnoresInvertColors
      style={{ width: size, height: size, transform }}
    />
  );
}

/** The pet's info and sheet (sprite pets) or the info only (stills pets), loaded when `enabled` and `petId` are set. */
export interface PetAsset { info: PetInfo; url: string | null }
export function usePetAsset(enabled: boolean, petId: string | null): { pet: PetAsset | null; drop: () => void } {
  const [pet, setPet] = useState<PetAsset | null>(null);
  useEffect(() => {
    if (!enabled || !petId) {
      setPet(null);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const list = await apiV4.pets();
        const info = list.find((p) => p.id === petId);
        if (!info) { if (alive) setPet(null); return; }
        if (info.kind === 'stills') { if (alive) setPet({ info, url: null }); return; }
        const url = await apiV4.petSheetBlobUrl(petId);
        if (alive) setPet({ info, url });
      } catch {
        if (alive) setPet(null);
      }
    })();
    return () => { alive = false; };
  }, [enabled, petId]);
  return { pet, drop: () => setPet(null) };
}

export interface PetSpriteProps extends ViewProps {
  info: PetInfo;
  /** sheet URL for sprite pets (null while loading) */
  sheetUrl: string | null;
  mode: PetMode;
  /** width of the pet in px (the cell width for sprite pets) */
  size: number;
  activity: PetActivity;
  /** change this number to play one wave (double tap, tap on native) */
  waveSeq?: number;
  /** set while the pet is being dragged: plays the walking row toward that side (stills tilt instead) */
  walk?: 'left' | 'right' | null;
  /** called when the sprite sheet image fails to load */
  onImageError?: () => void;
}

/**
 * The pet's picture and its animation: a sprite sheet cell per mode (frames advance on timers) or the
 * still image of the mode's state (see StillBody). The outer View is the pet's box (overflow hidden);
 * all other View props (touch handlers, pointer events, style) go to that box.
 */
export default function PetSprite({ info, sheetUrl, mode, size, activity, waveSeq, walk, onImageError, style, ...rest }: PetSpriteProps) {
  const reduced = useReducedMotion(activity);
  const hidden = usePageHidden();
  const [waving, setWaving] = useState(false);
  useEffect(() => {
    if (!waveSeq) return;
    setWaving(true);
    const id = setTimeout(() => setWaving(false), WAVE_MS);
    return () => clearTimeout(id);
  }, [waveSeq]);

  const stills = info.kind === 'stills';
  const effMode: PetMode = waving ? 'waving' : mode;
  const row = reduced ? 0 : walk ? (walk === 'left' ? 2 : 1) : PET_ROW_FOR_MODE[effMode];
  const [st, setSt] = useState({ row: 0, frame: 0 });
  const frame = !reduced && st.row === row ? st.frame : 0;
  const frames = PET_ROWS[row];

  // Sprite frame advance: one timeout per frame, using the row's durations scaled by the activity level.
  useEffect(() => {
    if (reduced || hidden || stills) return;
    let ms = frames[frame] * ACTIVITY_SCALE[activity];
    // Low activity: the idle pose holds on frame 0 for longer.
    if (row === 0 && frame === 0 && activity === 'low') ms *= 3;
    const id = setTimeout(() => setSt({ row, frame: (frame + 1) % frames.length }), ms);
    return () => clearTimeout(id);
  }, [row, frame, frames, reduced, hidden, activity, stills]);

  const boxH = petBoxHeight(stills, size);
  const sheetH = SHEET_H[info.spriteVersionNumber ?? 2] ?? SHEET_H[2];
  const scale = size / CELL_W;

  return (
    <View {...rest} style={[{ width: size, height: boxH, overflow: 'hidden' }, walk && stills && !reduced ? { transform: [{ rotate: walk === 'left' ? '-6deg' : '6deg' }] } : null, style]}>
      {stills ? (
        <StillBody id={info.id} states={info.states} state={petStateKey(effMode)} size={size} activity={activity} still={!reduced && !hidden} />
      ) : sheetUrl ? (
        <Image
          source={{ uri: sheetUrl }}
          resizeMode="stretch"
          accessibilityIgnoresInvertColors
          onError={onImageError}
          style={{
            position: 'absolute',
            left: -frame * size,
            top: -row * boxH,
            width: SHEET_W * scale,
            height: sheetH * scale,
          }}
        />
      ) : null}
    </View>
  );
}
