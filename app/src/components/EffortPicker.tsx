import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, Platform, Text, View } from 'react-native';
import type { Effort } from '../protocol';
import { useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';

/** Discrete steps of the slider, left to right. null = Default (no effort sent). */
const STEPS: (Effort | null)[] = [null, 'off', 'low', 'medium', 'high', 'max'];
const LAST = STEPS.length - 1;
const LABEL_KEYS = ['effort.default.picker', 'effort.off', 'effort.low', 'effort.medium', 'effort.high', 'effort.max'];

const TOUCH_H = 44; // touch area height
const THUMB = 28; // visible thumb diameter
const TRACK_H = 6;
const TICK_H = 12;
const LABEL_W = 72; // the first step is two lines of up to 6 full-width characters
const PAD = LABEL_W / 2 + 4; // keeps the end thumbs and the end labels inside the control
const LABEL_TOP = TOUCH_H + 2;
const LABEL_H = 30; // two lines (the first and second steps wrap)

/** Default / Off / Low / Medium / High / Max slider. Tap or drag the thumb to pick a step; arrow keys work on web. */
export default function EffortPicker({ value, onChange, disabled }: { value: Effort | null; onChange: (e: Effort | null) => void; disabled?: boolean }) {
  const t = useTheme();
  const square = useThemeDef().def.id === 'frontier';
  const tr = useT();
  const labels = LABEL_KEYS.map((k) => tr(k));
  const index = Math.max(0, STEPS.findIndex((s) => s === (value || null)));

  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);
  const ref = useRef<View>(null);
  const dragRef = useRef<number | null>(null);
  const originRef = useRef<number | null>(null);
  const activeRef = useRef(false);
  // latest values for the gesture/keyboard handlers, which are created once
  const live = useRef({ index, width, disabled: !!disabled, onChange });
  live.current = { index, width, disabled: !!disabled, onChange };

  const span = Math.max(1, width - PAD * 2);
  const xOf = (i: number) => PAD + (i / LAST) * span;
  // read the width through `live`: the gesture handlers are created once and would otherwise see width 0
  const stepAt = (x: number) => {
    const s = Math.max(1, live.current.width - PAD * 2);
    return Math.min(LAST, Math.max(0, Math.round(((x - PAD) / s) * LAST)));
  };
  const shown = drag ?? index;

  const setDragIdx = (i: number | null) => { dragRef.current = i; setDrag(i); };

  /** Ends a tap or drag: commits the step under the thumb, once. */
  const finish = () => {
    activeRef.current = false;
    originRef.current = null;
    const i = dragRef.current;
    setDragIdx(null);
    if (i !== null && i !== live.current.index) live.current.onChange(STEPS[i]);
  };

  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => !live.current.disabled,
    onMoveShouldSetPanResponder: () => !live.current.disabled,
    onPanResponderGrant: (evt) => {
      activeRef.current = true;
      const pageX = evt.nativeEvent.pageX;
      // web: read the track's page offset synchronously; native: measure it (async)
      const el: any = ref.current;
      if (Platform.OS === 'web' && el && typeof el.getBoundingClientRect === 'function') {
        const left = el.getBoundingClientRect().left + (typeof window !== 'undefined' ? window.scrollX : 0);
        originRef.current = left;
        setDragIdx(stepAt(pageX - left));
        return;
      }
      ref.current?.measure((_x, _y, _w, _h, pageLeft) => {
        if (!activeRef.current) return; // released before the measurement came back
        originRef.current = pageLeft;
        setDragIdx(stepAt(pageX - pageLeft));
      });
    },
    onPanResponderMove: (_e, g) => {
      if (originRef.current === null) return;
      const i = stepAt(g.moveX - originRef.current);
      if (i !== dragRef.current) setDragIdx(i);
    },
    onPanResponderRelease: finish,
    onPanResponderTerminate: finish,
  }), []);

  // web: arrow keys / Home / End when the slider is focused
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const node = ref.current as any;
    if (!node || typeof node.addEventListener !== 'function') return;
    const onKey = (e: KeyboardEvent) => {
      const { index: cur, disabled: dis, onChange: change } = live.current;
      if (dis) return;
      let next: number;
      switch (e.key) {
        case 'ArrowLeft': case 'ArrowDown': next = cur - 1; break;
        case 'ArrowRight': case 'ArrowUp': next = cur + 1; break;
        case 'Home': next = 0; break;
        case 'End': next = LAST; break;
        default: return;
      }
      e.preventDefault();
      const clamped = Math.min(LAST, Math.max(0, next));
      if (clamped !== cur) change(STEPS[clamped]);
    };
    node.addEventListener('keydown', onKey);
    return () => node.removeEventListener('keydown', onKey);
  }, []);

  const onAccessibilityAction = (e: { nativeEvent: { actionName: string } }) => {
    const { index: cur, disabled: dis, onChange: change } = live.current;
    if (dis) return;
    const delta = e.nativeEvent.actionName === 'increment' ? 1 : e.nativeEvent.actionName === 'decrement' ? -1 : 0;
    const next = Math.min(LAST, Math.max(0, cur + delta));
    if (delta && next !== cur) change(STEPS[next]);
  };

  const webOnly: any = Platform.OS === 'web' ? { touchAction: 'none', cursor: disabled ? 'default' : 'pointer' } : null;
  const webFocus: any = Platform.OS === 'web' ? { tabIndex: disabled ? -1 : 0 } : {};
  const trackTop = (TOUCH_H - TRACK_H) / 2;

  return (
    <View style={{ minWidth: 300, width: '100%', paddingVertical: 4, opacity: disabled ? 0.45 : 1 }}>
      <View
        ref={ref}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        {...(disabled ? {} : pan.panHandlers)}
        {...webFocus}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={tr('effort.title')}
        accessibilityValue={{ min: 0, max: LAST, now: shown, text: labels[shown] }}
        accessibilityState={{ disabled: !!disabled }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={onAccessibilityAction}
        style={[{ height: LABEL_TOP + LABEL_H, width: '100%' }, webOnly]}
      >
        {/* track */}
        <View style={{ position: 'absolute', left: PAD, right: PAD, top: trackTop, height: TRACK_H, borderRadius: square ? 0 : TRACK_H / 2, backgroundColor: t.border }} />
        {/* filled portion up to the current step */}
        <View style={{ position: 'absolute', left: PAD, width: Math.max(0, xOf(shown) - PAD), top: trackTop, height: TRACK_H, borderRadius: square ? 0 : TRACK_H / 2, backgroundColor: t.accent }} />
        {/* tick marks */}
        {STEPS.map((_, i) => (
          <View key={`tick-${i}`} style={{ position: 'absolute', left: xOf(i) - 1, width: 2, top: (TOUCH_H - TICK_H) / 2, height: TICK_H, borderRadius: 1, backgroundColor: i <= shown ? t.accent : t.sub }} />
        ))}
        {/* thumb: 28px visible inside the 44px touch area */}
        <View
          style={{
            position: 'absolute',
            left: xOf(shown) - THUMB / 2,
            top: (TOUCH_H - THUMB) / 2,
            width: THUMB,
            height: THUMB,
            borderRadius: square ? 0 : THUMB / 2,
            backgroundColor: t.accent,
            borderWidth: 3,
            borderColor: t.bg,
          }}
        />
        {/* labels under the ticks */}
        {labels.map((label, i) => {
          const current = i === shown;
          return (
            <Text
              key={`label-${i}`}
              numberOfLines={2}
              style={{
                position: 'absolute',
                left: xOf(i) - LABEL_W / 2,
                width: LABEL_W,
                top: LABEL_TOP,
                textAlign: 'center',
                fontSize: 11,
                color: current ? t.accentInk : t.sub,
                fontWeight: current ? '700' : '400',
              }}
            >
              {label}
            </Text>
          );
        })}
      </View>
    </View>
  );
}
