import React, { useRef, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import type { GestureResponderEvent, LayoutChangeEvent } from 'react-native';
import { useTheme } from '../theme';

/** Horizontal slider (touch, mouse and keyboard arrows on web). `value` is snapped to `step`. */
export default function SliderField({ value, min, max, step = 0.1, onChange, label, format }: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  label: string;
  format?: (v: number) => string;
}) {
  const t = useTheme();
  const ref = useRef<View>(null);
  const [w, setW] = useState(0);
  const left = useRef(0);
  const snap = (v: number) => {
    const c = Math.min(max, Math.max(min, v));
    const s = Math.round((c - min) / step) * step + min;
    return Math.round(Math.min(max, s) * 1000) / 1000;
  };
  const frac = max > min ? (Math.min(max, Math.max(min, value)) - min) / (max - min) : 0;
  const setFromX = (pageX: number) => {
    if (w <= 0) return;
    onChange(snap(min + ((pageX - left.current) / w) * (max - min)));
  };
  const begin = (e: GestureResponderEvent) => {
    const pageX = e.nativeEvent.pageX;
    ref.current?.measureInWindow((x) => { left.current = x; setFromX(pageX); });
  };
  const onKey = (e: any) => {
    const k = e?.nativeEvent?.key ?? e?.key;
    if (k === 'ArrowRight' || k === 'ArrowUp') { e.preventDefault?.(); onChange(snap(value + step)); }
    if (k === 'ArrowLeft' || k === 'ArrowDown') { e.preventDefault?.(); onChange(snap(value - step)); }
  };
  const web: any = Platform.OS === 'web' ? { tabIndex: 0, onKeyDown: onKey, style: { cursor: 'pointer', outlineStyle: 'none' } } : {};
  return (
    <View style={{ marginTop: 6 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
        <Text style={{ color: t.text, fontSize: 13, fontWeight: '600' }}>{label}</Text>
        <Text style={{ color: t.sub, fontSize: 13 }}>{format ? format(value) : String(value)}</Text>
      </View>
      <View
        ref={ref}
        onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={begin}
        onResponderMove={(e) => setFromX(e.nativeEvent.pageX)}
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ min, max, now: value }}
        {...web}
        style={[{ height: 28, justifyContent: 'center' }, web.style]}
      >
        <View style={{ height: 4, borderRadius: 2, backgroundColor: t.border }} pointerEvents="none" />
        <View style={{ position: 'absolute', left: 0, width: `${frac * 100}%`, height: 4, borderRadius: 2, backgroundColor: t.accent }} pointerEvents="none" />
        <View
          pointerEvents="none"
          style={{ position: 'absolute', left: `${frac * 100}%`, marginLeft: -9, width: 18, height: 18, borderRadius: 9, backgroundColor: t.accent, borderWidth: 2, borderColor: t.bg }}
        />
      </View>
    </View>
  );
}
