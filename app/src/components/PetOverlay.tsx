import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, Platform, Text, Vibration, View, useWindowDimensions } from 'react-native';
import { effectivePets, setDevice, useDevice } from '../deviceSettings';
import { useStore } from '../store';
import { clampPetPx, petAnchorBottom, petPosToPx, petPxToPos, type PetPx } from '../petPos';
import { LONG_PRESS_MS, reduceTouch, touchMayBeTaken, type PetTouchEvent, type PetTouchPhase } from '../petTouch';
import { desktopBridge } from '../desktopPet';
import { usePetMode, type PetMode } from '../petState';
import { useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';
import { Enter, Speech, Tag } from '../ui/skin';
import PetSprite, { petBoxHeight, usePetAsset } from './PetSprite';

/**
 * ChatScreen places this overlay in a zero-size box 12 px from the right of the chat area. The bottom anchor
 * depends on the width (petAnchorBottom: above the composer on narrow screens). Dragged positions are converted
 * to offsets from that box.
 */
const ANCHOR_RIGHT = 12;

/** Long-press move mode: the pet grows a little and gets an accent outline. */
const MOVE_SCALE = 1.08;

/**
 * Animated Codex pet over the chat. Renders nothing when pets are disabled, no pet is selected,
 * or the pet's image cannot be loaded. The whole sprite can be dragged (web: with the mouse, even with
 * click-through on; the walking animation plays toward the drag direction). On native, a 450 ms long press on the pet enters
 * move mode and a short tap waves. The position is stored per device as fractions and kept inside the window.
 * While the desktop pet window shows this pet (pets.desktop on, pets.inApp off), the in-app overlay hides.
 */
export default function PetOverlay({ convId }: { convId: string }) {
  const devicePets = useDevice((s) => s.pets);
  const syncedPetId = useStore((s) => s.settings?.activePetId ?? null);
  const { enabled, petId } = effectivePets(devicePets, syncedPetId);
  const { size, activity, clickThrough, pos, desktop, inApp } = devicePets;
  const { pet, drop } = usePetAsset(enabled, petId);
  const mode = usePetMode(convId);
  const { width: W, height: H } = useWindowDimensions();
  const anchorBottom = petAnchorBottom(W);
  const [drag, setDrag] = useState<PetPx | null>(null);
  const [walk, setWalk] = useState<'left' | 'right' | null>(null);
  const [moving, setMoving] = useState(false);
  const [waveSeq, setWaveSeq] = useState(0);
  const tr = useT();
  const t = useTheme();
  const native = Platform.OS !== 'web';
  const hiddenHere = desktop && !inApp && !!desktopBridge();

  // Position: the stored fractions (or the default spot), or the live drag position while dragging.
  const stills = pet?.info.kind === 'stills';
  const cellW = size;
  const boxH = petBoxHeight(!!stills, size);
  const area = { w: W, h: H };
  const box = { w: cellW, h: boxH };
  const base: PetPx = pos
    ? petPosToPx(pos, area, box)
    : { left: W - ANCHOR_RIGHT - cellW, top: H - anchorBottom - boxH };
  const shown: PetPx = drag ?? base;
  const placed = !!(pos || drag);

  // The PanResponder is created once; it reads the latest values through this ref.
  const live = useRef({ clickThrough, area, box, shown, native });
  live.current = { clickThrough, area, box, shown, native };
  const grab = useRef<PetPx>({ left: 0, top: 0 });
  const latest = useRef<PetPx | null>(null);
  // Native long press: phase of the touch, its timer, the latest finger offset and the offset at move start.
  const touch = useRef<PetTouchPhase>('idle');
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const walkDx = useRef(0);
  const gesture = useRef({ dx: 0, dy: 0 });
  const moveBase = useRef({ dx: 0, dy: 0 });

  const pan = useMemo(() => {
    const finish = () => {
      const p = latest.current;
      latest.current = null;
      setDrag(null);
      setWalk(null);
      if (p) setDevice({ pets: { pos: petPxToPos(p, live.current.area, live.current.box) } });
    };
    /** Native touch state machine (pure logic in petTouch.ts); applies its effects. */
    const applyTouch = (ev: PetTouchEvent) => {
      const r = reduceTouch(touch.current, ev);
      touch.current = r.phase;
      if (r.phase !== 'pressing' && pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; }
      if (r.effect === 'vibrate') {
        moveBase.current = { ...gesture.current };
        Vibration.vibrate(15);
        setMoving(true);
      } else if (r.effect === 'tap') {
        setWaveSeq((n) => n + 1);
      } else if (r.effect === 'save') {
        setMoving(false);
        finish();
      }
    };
    const responder = () => {
      const can = () => true;
      return PanResponder.create({
        onStartShouldSetPanResponder: can,
        onMoveShouldSetPanResponder: (_e, g) => (live.current.native ? true : can() && (Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2)),
        onPanResponderTerminationRequest: () => (live.current.native ? touchMayBeTaken(touch.current) : true),
        onPanResponderGrant: () => {
          grab.current = live.current.shown;
          walkDx.current = 0;
          if (live.current.native) {
            gesture.current = { dx: 0, dy: 0 };
            applyTouch({ type: 'down' });
            if (pressTimer.current) clearTimeout(pressTimer.current);
            pressTimer.current = setTimeout(() => { pressTimer.current = null; applyTouch({ type: 'longPress' }); }, LONG_PRESS_MS);
          }
        },
        onPanResponderMove: (_e, g) => {
          const L = live.current;
          if (L.native) {
            gesture.current = { dx: g.dx, dy: g.dy };
            applyTouch({ type: 'move', dx: g.dx, dy: g.dy });
            if (touch.current !== 'moving') return;
          }
          const ox = L.native ? moveBase.current.dx : 0;
          const oy = L.native ? moveBase.current.dy : 0;
          const next = clampPetPx({ left: grab.current.left + g.dx - ox, top: grab.current.top + g.dy - oy }, L.area, L.box);
          latest.current = next;
          setDrag(next);
          if (Math.abs(g.dx - walkDx.current) >= 3) {
            setWalk(g.dx > walkDx.current ? 'right' : 'left');
            walkDx.current = g.dx;
          }
        },
        onPanResponderRelease: () => {
          if (live.current.native) applyTouch({ type: 'up' });
          else finish();
        },
        onPanResponderTerminate: () => {
          if (live.current.native) applyTouch({ type: 'terminate' });
          else finish();
        },
      });
    };
    return responder();
  }, []);

  // A pending long press must not fire after the overlay unmounts.
  useEffect(() => () => { if (pressTimer.current) clearTimeout(pressTimer.current); }, []);

  if (!enabled || !petId || !pet || hiddenHere) return null;

  const { info, url } = pet;
  const cursor: any = Platform.OS === 'web' ? { cursor: drag ? 'grabbing' : 'grab' } : null;

  return (
    <View
      pointerEvents="box-none"
      style={[
        { position: 'absolute', width: cellW, height: boxH, zIndex: 50 },
        placed
          ? { left: shown.left - (W - ANCHOR_RIGHT), top: shown.top - (H - anchorBottom) }
          : { right: 0, bottom: 0 },
      ]}
    >
      <PetSay mode={mode} bottom={boxH + 6} />
      <PetSprite
        {...pan.panHandlers}
        pointerEvents="auto"
        accessible={false}
        info={info}
        sheetUrl={url}
        mode={mode}
        size={size}
        activity={activity}
        waveSeq={waveSeq}
        walk={drag && (native ? moving : true) ? walk : null}
        onImageError={drop}
        style={[
          cursor,
          moving ? { transform: [{ scale: MOVE_SCALE }], borderWidth: 2, borderColor: t.accent, borderRadius: 8 } : null,
        ]}
      />
    </View>
  );
}

const SAY: Partial<Record<PetMode, string>> = {
  thinking: 'pets.say.thinking', running: 'pets.say.running', searching: 'pets.say.searching', waiting: 'pets.say.waiting', failed: 'pets.say.failed', jumping: 'pets.say.done', waving: 'pets.say.done',
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
