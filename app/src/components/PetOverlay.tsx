import React, { useEffect, useState } from 'react';
import { Image, Platform, Text, View } from 'react-native';
import { apiV4 } from '../apiV4';
import { useDevice } from '../deviceSettings';
import type { PetActivity } from '../deviceSettings';
import { PET_ROW_FOR_MODE, PET_ROWS, usePetMode, type PetMode } from '../petState';
import { useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';
import { Enter, Speech, Tag } from '../ui/skin';
import type { PetInfo } from '../protocol';

// Sprite sheet geometry (PROTOCOL-v4 section 9): 8 columns of 192x208 cells.
const CELL_W = 192;
const CELL_H = 208;
const SHEET_W = 1536;
const SHEET_H: Record<1 | 2, number> = { 1: 1872, 2: 2288 };

/** Frame time multiplier per activity level. */
const ACTIVITY_SCALE: Record<PetActivity, number> = { low: 2, normal: 1, high: 0.8 };

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

/**
 * Animated Codex pet over the chat. Renders nothing when pets are disabled, no pet is selected,
 * or the pet's sheet cannot be loaded. The sprite sheet is shown through a clipped View, so only
 * one cell is visible at a time.
 */
export default function PetOverlay({ convId }: { convId: string }) {
  const { enabled, petId, size, activity, clickThrough } = useDevice((s) => s.pets);
  const [pet, setPet] = useState<{ info: PetInfo; url: string } | null>(null);
  const mode = usePetMode(convId);
  const reduced = useReducedMotion(activity);
  const hidden = usePageHidden();

  const row = reduced ? 0 : PET_ROW_FOR_MODE[mode];
  const [st, setSt] = useState({ row: 0, frame: 0 });
  const frame = !reduced && st.row === row ? st.frame : 0;
  const frames = PET_ROWS[row];

  // Load the pet's info and sheet URL when the selected pet changes.
  useEffect(() => {
    if (!enabled || !petId) {
      setPet(null);
      return;
    }
    let alive = true;
    Promise.all([apiV4.pets(), apiV4.petSheetBlobUrl(petId)]).then(
      ([list, url]) => {
        if (!alive) return;
        const info = list.find((p) => p.id === petId);
        setPet(info ? { info, url } : null);
      },
      () => { if (alive) setPet(null); },
    );
    return () => { alive = false; };
  }, [enabled, petId]);

  // Frame advance: one timeout per frame, using the row's durations scaled by the activity level.
  useEffect(() => {
    if (reduced || hidden) return;
    let ms = frames[frame] * ACTIVITY_SCALE[activity];
    // Low activity: the idle pose holds on frame 0 for longer.
    if (row === 0 && frame === 0 && activity === 'low') ms *= 3;
    const id = setTimeout(() => setSt({ row, frame: (frame + 1) % frames.length }), ms);
    return () => clearTimeout(id);
  }, [row, frame, frames, reduced, hidden, activity]);

  if (!enabled || !petId || !pet) return null;

  const { info, url } = pet;
  const scale = size / CELL_W;
  const cellW = size;
  const cellH = size * CELL_H / CELL_W;
  const sheetH = SHEET_H[info.spriteVersionNumber] ?? SHEET_H[2];

  return (
    <>
    <PetSay mode={mode} bottom={cellH + 6} />
    <View
      pointerEvents={clickThrough ? 'none' : 'auto'}
      accessible={false}
      style={{ position: 'absolute', right: 0, bottom: 0, width: cellW, height: cellH, overflow: 'hidden', zIndex: 50 }}
    >
      <Image
        source={{ uri: url }}
        resizeMode="stretch"
        accessibilityIgnoresInvertColors
        onError={() => setPet(null)}
        style={{
          position: 'absolute',
          left: -frame * cellW,
          top: -row * cellH,
          width: SHEET_W * scale,
          height: sheetH * scale,
        }}
      />
    </View>
    </>
  );
}

const SAY: Partial<Record<PetMode, string>> = {
  running: 'pets.say.running', searching: 'pets.say.searching', waiting: 'pets.say.waiting', failed: 'pets.say.failed', jumping: 'pets.say.done', waving: 'pets.say.done',
};

/**
 * Short line the pet "says" for a few seconds when its state changes (themes only; Simple shows nothing).
 * Astral: white speech bubble with a tail. Frontier: a small status plate.
 */
function PetSay({ mode, bottom }: { mode: PetMode; bottom: number }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const [shown, setShown] = useState<PetMode | null>(null);
  useEffect(() => {
    if (!SAY[mode]) { setShown(null); return; }
    setShown(mode);
    const id = setTimeout(() => setShown(null), 4000);
    return () => clearTimeout(id);
  }, [mode]);
  const hint = th.def.variants.hint;
  if (!shown || hint === 'plain' || !th.fx) return null;
  const text = tr(SAY[shown] as string);
  return (
    <View pointerEvents="none" style={{ position: 'absolute', right: 0, bottom, maxWidth: 220, zIndex: 51 }}>
      <Enter from="right">
        {hint === 'speech' ? (
          <Speech tail="right"><Text style={{ color: '#2a2827', fontSize: 13 }}>{text}</Text></Speech>
        ) : (
          <View style={{ backgroundColor: t.panel, borderWidth: 1, borderColor: t.borderStrong, borderLeftWidth: 3, borderLeftColor: shown === 'failed' ? t.danger : th.dark ? t.accent : t.text, paddingHorizontal: 10, paddingVertical: 7, gap: 4 }}>
            <Tag>{tr('pets.say.status')}</Tag>
            <Text style={{ color: t.text, fontSize: 13 }}>{text}</Text>
          </View>
        )}
      </Enter>
    </View>
  );
}
