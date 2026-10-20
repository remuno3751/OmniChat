import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, Ellipse, G, Line, LinearGradient, Path, Pattern, Rect, Stop } from 'react-native-svg';
import { Platform } from 'react-native';
import type { ThemeDef } from '../themes';
import { useTheme, useThemeDef } from '../theme';

/** Original, static ornaments drawn with react-native-svg / View borders. Nothing here animates. */

/** Four-point star centred at (cx, cy) with radius r. */
export function starPath(cx: number, cy: number, r: number): string {
  const k = r * 0.22;
  return `M${cx} ${cy - r} Q${cx + k} ${cy - k} ${cx + r} ${cy} Q${cx + k} ${cy + k} ${cx} ${cy + r} Q${cx - k} ${cy + k} ${cx - r} ${cy} Q${cx - k} ${cy - k} ${cx} ${cy - r}Z`;
}

export function FourStar({ size = 14, color }: { size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20">
      <Path d={starPath(10, 10, 9)} fill={color} />
    </Svg>
  );
}

/** Deterministic pseudo-random list so the star field is the same on every render. */
function stars(n: number): { x: number; y: number; r: number; o: number; big: boolean }[] {
  let s = 7;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  return Array.from({ length: n }, (_, i) => ({ x: rnd() * 1600, y: rnd() * 1000, r: 0.6 + rnd() * 1.1, o: 0.25 + rnd() * 0.5, big: i % 11 === 0 }));
}

/** Full-bleed static background layer: hatch + grid (Frontier) or gradient + star field + orbit lines (Astral). */
export function ThemeBackground() {
  const { def, fx, dark } = useThemeDef();
  const t = useTheme();
  const field = useMemo(() => stars(70), []);
  const { pattern, patternOpacity, orbits, gradientBg } = def.decor;
  const grad = gradientBg && dark ? gradientBg : null;
  if (!grad && (!fx || pattern === 'none')) return null;
  const showPattern = fx && pattern !== 'none';
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width="100%" height="100%" preserveAspectRatio={pattern === 'starfield' ? 'xMidYMid slice' : undefined} viewBox={pattern === 'starfield' ? '0 0 1600 1000' : undefined}>
        <Defs>
          {grad && (
            <LinearGradient id="bgGrad" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={grad[0]} />
              <Stop offset="1" stopColor={grad[1]} />
            </LinearGradient>
          )}
          {pattern === 'hatch' && (
            <Pattern id="hatch" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <Line x1="0" y1="0" x2="0" y2="12" stroke={t.text} strokeWidth="1" />
            </Pattern>
          )}
          {pattern === 'hatch' && (
            <Pattern id="grid" width="96" height="96" patternUnits="userSpaceOnUse">
              <Path d="M96 0H0V96" fill="none" stroke={t.text} strokeWidth="1" />
            </Pattern>
          )}
        </Defs>
        {grad && <Rect width="100%" height="100%" fill="url(#bgGrad)" />}
        {showPattern && pattern === 'hatch' && (
          <>
            <Rect width="100%" height="100%" fill="url(#hatch)" opacity={patternOpacity * 0.6} />
            <Rect width="100%" height="100%" fill="url(#grid)" opacity={patternOpacity} />
          </>
        )}
        {showPattern && pattern === 'starfield' && (
          <G opacity={dark ? patternOpacity : patternOpacity * 0.5}>
            {orbits && (
              <>
                <Ellipse cx="1180" cy="330" rx="520" ry="150" fill="none" stroke={t.borderStrong} strokeWidth="1" opacity="0.35" transform="rotate(-18 1180 330)" />
                <Ellipse cx="1180" cy="330" rx="680" ry="210" fill="none" stroke={t.borderStrong} strokeWidth="1" opacity="0.2" transform="rotate(-18 1180 330)" />
              </>
            )}
            {field.map((p, i) => p.big
              ? <Path key={i} d={starPath(p.x, p.y, 7 + p.r * 3)} fill={t.accentInk} opacity={p.o} />
              : <Circle key={i} cx={p.x} cy={p.y} r={p.r} fill={t.text} opacity={p.o} />)}
          </G>
        )}
      </Svg>
    </View>
  );
}

/** Corner brackets `[ ]` around the parent box (absolute, non-interactive). Renders nothing unless the theme has them and effects are on. */
export function Brackets({ color, size, inset = 0 }: { color?: string; size?: number; inset?: number }) {
  const { def, fx } = useThemeDef();
  const t = useTheme();
  const arm = size ?? def.shape.bracket;
  if (!fx || !arm) return null;
  const c = color ?? t.borderStrong;
  const base = { position: 'absolute' as const, width: arm, height: arm, borderColor: c };
  const o = -inset;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={[base, { top: o, left: o, borderTopWidth: 1, borderLeftWidth: 1 }]} />
      <View style={[base, { top: o, right: o, borderTopWidth: 1, borderRightWidth: 1 }]} />
      <View style={[base, { bottom: o, left: o, borderBottomWidth: 1, borderLeftWidth: 1 }]} />
      <View style={[base, { bottom: o, right: o, borderBottomWidth: 1, borderRightWidth: 1 }]} />
    </View>
  );
}

/** Dotted inner border (Astral cards): an inset dotted rectangle. */
export function DottedInner({ color, inset = 4, radius = 8 }: { color?: string; inset?: number; radius?: number }) {
  const { def, fx } = useThemeDef();
  const t = useTheme();
  if (!fx || !def.shape.dottedInner) return null;
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', top: inset, left: inset, right: inset, bottom: inset, borderWidth: 1, borderStyle: 'dotted', borderColor: color ?? t.borderStrong, borderRadius: radius, opacity: 0.6 }}
    />
  );
}

/** Thin diagonal-striped strip (hazard-style track) used by the Frontier progress bar. */
export function HatchTrack({ width, height = 6, color }: { width: number; height?: number; color: string }) {
  const n = Math.ceil(width / 6);
  return (
    <Svg width={width} height={height}>
      {Array.from({ length: n }, (_, i) => <Line key={i} x1={i * 6} y1={height} x2={i * 6 + height} y2={0} stroke={color} strokeWidth="1" />)}
    </Svg>
  );
}

/** Soft drop shadow for raised surfaces (popups); empty for themes without one or with effects off. */
export function shadowStyle(def: ThemeDef, fx: boolean): any {
  const s = def.shadow;
  if (!fx || s.kind === 'none') return null;
  if (Platform.OS === 'web') return { boxShadow: `0 ${s.offsetY}px ${s.radius}px rgba(0,0,0,${s.opacity})` };
  return { shadowColor: '#000', shadowOpacity: s.opacity, shadowRadius: s.radius, shadowOffset: { width: 0, height: s.offsetY }, elevation: 8 };
}
